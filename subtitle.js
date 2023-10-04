require('dotenv').config()

const path = require('path')
const fs = require('fs')
const { Configuration, OpenAIApi } = require('openai')
const Bottleneck = require('bottleneck')
const { map, resync, parse, stringify } = require('subtitle')
const c = require('picocolors')
const { exec, getDuration, srtToTxt, errorLog } = require('./utils')

const { argPath, formats } = resolveArgs(process.argv)

function resolveArgs(args) {
  const argPath = args[2]

  const supprtsFormats = ['srt', 'txt']
  const formatIndex = args.findIndex(v => v === '--format')
  const formats = formatIndex !== -1
    ? args[formatIndex + 1].split(',')
    : process.env.SUBTITLE_FORMAT
      ? process.env.SUBTITLE_FORMAT.split(',')
      : ['srt']

  if (!Array.isArray(formats) || !formats.every(v => supprtsFormats.includes(v))) {
    throw new Error(`Argument --format ${formats} is invalid, supported formats: ${supprtsFormats}`)
  }

  return { argPath, formats }
}

async function main() {
  // vars
  const videoPath = path.relative(process.cwd(), argPath)
  const videoName = path.basename(videoPath)
  const audioPath = videoPath.replace(/.(\w+)$/, '_tmp.mp3')
  const outputPaths = formats.map(format => videoPath.replace(/.(\w+)$/, `.${format}`))
  const chunkSize = 24 // MB
  let fullOutputContents = formats.reduce((contents, format) => {
    contents[format] = ''
    return contents
  }, {})

  // utils
  const print = (message, isSuccessfully) => {
    console.log(
      c.white(c.bgCyan(` ${videoName} `)) +
      (isSuccessfully
        ? c.green(` ${message}`)
        : ` ${message}`)
    )
  }

  // instance
  const limiter = new Bottleneck({ maxConcurrent: 1 })
  const openAiConfig = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
    baseOptions: {
      // Using Infinity is to fix ERR_FR_MAX_BODY_LENGTH_EXCEEDED error
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  })
  const openai = new OpenAIApi(openAiConfig)

  if (!fs.existsSync(path.resolve(process.cwd(), audioPath))) {
    try {
      await exec('ffmpeg', ['-i', videoPath, audioPath])
    } catch (error) {
      errorLog(error)
    }
    print(`轉換音檔 ${audioPath}`)
  }

  // calculate splits size
  const audioStats = fs.statSync(path.resolve(process.cwd(), audioPath))
  const audioSize = audioStats.size / (1024 * 1024) // MB
  const chunkCount = Math.ceil(audioSize / chunkSize)

  // calculate chunk video duration
  let duration = 0
  try {
    duration = await getDuration(path.resolve(process.cwd(), audioPath))
  } catch (error) {
    errorLog(error)
  }
  const chunkDuration = duration * (chunkSize / audioSize)

  await Promise.all(
    Array.from({ length: chunkCount }).map((_, index) => limiter.schedule(async () => {
      const limiter = new Bottleneck({ maxConcurrent: 1 })
      const chunkPath = audioPath.replace(/_tmp.(\w+)$/, `_chunk_${index}.$1`)
      const chunkOutputPaths = formats.map(format => videoPath.replace(/.(\w+)$/, `_chunk_${index}.${format}`))
      const chunkSrtPath = videoPath.replace(/.(\w+)$/, `_chunk_${index}.srt`)
      const startDuration = chunkDuration * index // 秒
      const realChunkDuration = Math.min(chunkDuration, duration - startDuration)

      // split on ffmpeg
      if (!fs.existsSync(path.resolve(process.cwd(), chunkPath))) {
        try {
          await exec('ffmpeg', [
            `-i`, audioPath,
            `-ss`, startDuration,
            `-t`, chunkDuration,
            chunkPath,
          ])
        } catch (error) {
          errorLog(error)
        }
        print(`分割影片 ${chunkPath}`)
      }

      // upload to whisper
      const stream = fs.createReadStream(path.resolve(process.cwd(), chunkPath))
      let prompt
      if (fs.existsSync(path.resolve(__dirname, 'prompt.txt')))
        prompt = fs.readFileSync(path.resolve(__dirname, 'prompt.txt'), { encoding: 'utf-8' })
      let srt = ''
      try {
        const { data } = await openai.createTranscription(stream, 'whisper-1', prompt || undefined, 'srt')
        srt = data
      } catch (error) {
        errorLog(error)
      }
      fs.writeFileSync(path.resolve(process.cwd(), chunkSrtPath), srt, {
        encoding: 'utf-8',
      })
      await Promise.all(
        chunkOutputPaths.map(chunkOutputPath => limiter.schedule(async () => {
          const format = resolveFormatFromPath(chunkOutputPath)

          // transform srt to txt
          if (format === 'txt') {
            const content = await srtToTxt(chunkSrtPath)
            fs.writeFileSync(path.resolve(process.cwd(), chunkOutputPath), content, {
              encoding: 'utf-8',
            })
          }
        }))
      )
      print(`生成字幕 ${chunkPath}`)

      // handle subtitle files
      await Promise.all(
        chunkOutputPaths.map(chunkOutputPath => limiter.schedule(async () => {
          const format = resolveFormatFromPath(chunkOutputPath)
          let chunkContent = ''

          if (format === 'srt') {
            // move srt time
            chunkContent = await new Promise(resolve => {
              const chunks = []
              fs.createReadStream(path.resolve(process.cwd(), chunkOutputPath))
                .pipe(parse())
                .pipe(map(node => {
                  if (node.type === 'cue') {
                    // fix first subtitle time
                    if (node.data.start < 0)
                      node.data.start = 0
                    // fix last subtitle time
                    if (node.data.end > (realChunkDuration * 1000)) // 毫秒
                      node.data.end = realChunkDuration * 1000
                  }
                  return node
                }))
                .pipe(resync(startDuration * 1000)) // 毫秒
                .pipe(stringify({ format: 'SRT' }))
                .on('data', chunk => chunks.push(Buffer.from(chunk)))
                .on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
            })
          } else if (format === 'txt') {
            chunkContent = fs.readFileSync(path.resolve(process.cwd(), chunkOutputPath), { encoding: 'utf-8' })
          }

          // concat full srt file
          if (fullOutputContents[format]) fullOutputContents[format] += '\n'
          fullOutputContents[format] += chunkContent
        }))
      )

      // clear temp files
      if (fs.existsSync(path.resolve(process.cwd(), chunkPath)))
        fs.rmSync(path.resolve(process.cwd(), chunkPath))
      if (fs.existsSync(path.resolve(process.cwd(), chunkSrtPath)))
        fs.rmSync(path.resolve(process.cwd(), chunkSrtPath))
      for (const chunkOutputPath of chunkOutputPaths) {
        if (fs.existsSync(path.resolve(process.cwd(), chunkOutputPath)))
          fs.rmSync(path.resolve(process.cwd(), chunkOutputPath))
      }

      print(`處理字幕 ${chunkPath}`)
    }))
  )

  // save full srt
  await Promise.all(
    outputPaths.map(outputPath => limiter.schedule(async () => {
      const format = resolveFormatFromPath(outputPath)

      fs.writeFileSync(path.resolve(process.cwd(), outputPath), fullOutputContents[format], {
        encoding: 'utf-8',
      })

      if (format === 'srt') {
        fullOutputContents[format] = await new Promise(resolve => {
          const chunks = []
          fs.createReadStream(path.resolve(process.cwd(), outputPath))
            .pipe(parse())
            .pipe(stringify({ format: 'SRT' }))
            .on('data', chunk => chunks.push(Buffer.from(chunk)))
            .on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        })
        fs.writeFileSync(path.resolve(process.cwd(), outputPath), fullOutputContents[format], {
          encoding: 'utf-8',
        })
      }

      print(`字幕完成 ${outputPath}`, true)
    }))
  )

  // clear temp files
  if (fs.existsSync(path.resolve(process.cwd(), audioPath)))
    fs.rmSync(path.resolve(process.cwd(), audioPath))
}

function resolveFormatFromPath(path) {
  return path.match(/\.(\w+)$/)[1]
}

main()

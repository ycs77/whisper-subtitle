import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import OpenAI from 'openai'
import Bottleneck from 'bottleneck'
import { map, resync, parse, stringify } from 'subtitle'
import c from 'picocolors'
import { exec, getDuration, srtToTxt, generatePrintLog, errorLog } from './utils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const { argPath, formats, language } = resolveArgs(process.argv)

function resolveArgs(args) {
  const argPath = args[2]

  const supprtsFormats = ['srt', 'txt']
  const formatIndex = args.findIndex(v => v === '--format')
  const formats = formatIndex !== -1
    ? args[formatIndex + 1].split(',')
    : process.env.SUBTITLE_FORMAT
      ? process.env.SUBTITLE_FORMAT.split(',')
      : ['srt']
  const language = process.env.SUBTITLE_LANGUAGE

  if (!Array.isArray(formats) || !formats.every(v => supprtsFormats.includes(v))) {
    throw new Error(`Argument --format ${formats} is invalid, supported formats: ${supprtsFormats}`)
  }

  return { argPath, formats, language }
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
  const printLog = generatePrintLog(videoName)

  // instance
  const limiter = new Bottleneck({ maxConcurrent: 1 })
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  // print info
  console.log()
  console.log(`  ${c.cyan('Formats:')}   ${c.yellow(formats.join(', '))}`)
  console.log(`  ${c.cyan('Language:')}  ${language ? c.yellow(language) : c.dim('未設定')}`)
  console.log(`  ${c.cyan('Prompt:')}    ${
    fs.existsSync(path.resolve(__dirname, 'prompt.txt'))
      ? c.green('已設定')
      : c.dim('未設定')
  }`)
  console.log()

  // transform video to audio
  if (fs.existsSync(path.resolve(process.cwd(), audioPath))) {
    printLog(`音檔已存在 ${audioPath}`, 'warning')
  } else {
    printLog(`轉換音檔開始 ${audioPath}`)
    try {
      await exec('ffmpeg', ['-i', videoPath, audioPath])
    } catch (error) {
      errorLog(error)
    }
    printLog(`轉換音檔完成 ${audioPath}`, 'success')
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
      if (fs.existsSync(path.resolve(process.cwd(), chunkPath))) {
        printLog(`影片片段已存在 ${chunkPath}`, 'warning')
      } else {
        printLog(`分割影片開始 ${chunkPath}`)
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
        printLog(`分割影片完成 ${chunkPath}`, 'success')
      }

      // upload to whisper
      printLog(`生成片段字幕開始 ${chunkPath}`)
      let prompt
      if (fs.existsSync(path.resolve(__dirname, 'prompt.txt'))) {
        prompt = fs.readFileSync(path.resolve(__dirname, 'prompt.txt'), { encoding: 'utf-8' })
      }
      let srt = ''
      try {
        srt = await openai.audio.transcriptions.create({
          model: 'whisper-1',
          file: fs.createReadStream(path.resolve(process.cwd(), chunkPath)),
          language: language,
          prompt,
          response_format: 'srt',
        })
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
      printLog(`生成片段字幕完成 ${chunkPath}`, 'success')

      // handle subtitle files
      printLog(`處理片段字幕開始 ${chunkPath}`)
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

      printLog(`處理片段字幕完成 ${chunkPath}`, 'success')
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

      printLog(`字幕完成 ${outputPath}`, 'success')
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

require('dotenv').config()

const path = require('path')
const fs = require('fs')
const { Configuration, OpenAIApi } = require('openai')
const Bottleneck = require('bottleneck')
const { map, resync, parse, stringify } = require('subtitle')
const c = require('picocolors')
const { exec, getDuration } = require('./utils')

const arguPath = process.argv[2]

async function main() {
  // vars
  const videoPath = path.relative(process.cwd(), arguPath)
  const videoName = path.basename(videoPath)
  const audioPath = videoPath.replace(/.(\w+)$/, '_tmp.mp3')
  const srtOutputPath = videoPath.replace(/.(\w+)$/, '.srt')
  const chunkSize = 24 // MB
  let fullSrtContent = ''

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
    await exec('ffmpeg', ['-i', videoPath, audioPath])
    print(`轉換音檔 ${audioPath}`)
  }

  // calculate splits size
  const audioStats = fs.statSync(path.resolve(process.cwd(), audioPath))
  const audioSize = audioStats.size / (1024 * 1024) // MB
  const chunkCount = Math.ceil(audioSize / chunkSize)

  // calculate chunk video duration
  const duration = await getDuration(path.resolve(process.cwd(), audioPath))
  const chunkDuration = duration * (chunkSize / audioSize)

  await Promise.all(
    Array.from({ length: chunkCount }).map((_, index) => limiter.schedule(async () => {
      const chunkFilePath = audioPath.replace(/_tmp.(\w+)$/, `_chunk_${index}.$1`)
      const chunkSrtFilePath = videoPath.replace(/.(\w+)$/, `_chunk_${index}.srt`)
      const startDuration = chunkDuration * index // 秒
      const realChunkDuration = Math.min(chunkDuration, duration - startDuration)

      // split on ffmpeg
      if (!fs.existsSync(path.resolve(process.cwd(), chunkFilePath))) {
        await exec('ffmpeg', [
          `-i`, audioPath,
          `-ss`, startDuration,
          `-t`, chunkDuration,
          chunkFilePath,
        ])
        print(`分割影片 ${chunkFilePath}`)
      }

      // upload to whisper
      const stream = fs.createReadStream(path.resolve(process.cwd(), chunkFilePath))
      const { data: srt } = await openai.createTranscription(stream, 'whisper-1', undefined, 'srt')
      fs.writeFileSync(path.resolve(process.cwd(), chunkSrtFilePath), srt, {
        encoding: 'utf-8',
      })
      print(`生成字幕 ${chunkFilePath}`)

      // move srt time
      const newSrtContent = await new Promise(resolve => {
        const chunks = []
        fs.createReadStream(path.resolve(process.cwd(), chunkSrtFilePath))
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

      // concat full srt file
      if (fullSrtContent) fullSrtContent += "\n"
      fullSrtContent += newSrtContent

      // clear temp files
      if (fs.existsSync(path.resolve(process.cwd(), chunkFilePath)))
        fs.rmSync(path.resolve(process.cwd(), chunkFilePath))
      if (fs.existsSync(path.resolve(process.cwd(), chunkSrtFilePath)))
        fs.rmSync(path.resolve(process.cwd(), chunkSrtFilePath))

      print(`處理字幕 ${chunkFilePath}`)
    }))
  )

  // save full srt
  fs.writeFileSync(path.resolve(process.cwd(), srtOutputPath), fullSrtContent, {
    encoding: 'utf-8',
  })
  fullSrtContent = await new Promise(resolve => {
    const chunks = []
    fs.createReadStream(path.resolve(process.cwd(), srtOutputPath))
      .pipe(parse())
      .pipe(stringify({ format: 'SRT' }))
      .on('data', chunk => chunks.push(Buffer.from(chunk)))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
  fs.writeFileSync(path.resolve(process.cwd(), srtOutputPath), fullSrtContent, {
    encoding: 'utf-8',
  })
  print(`字幕完成 ${srtOutputPath}`, true)

  // clear temp files
  if (fs.existsSync(path.resolve(process.cwd(), audioPath)))
    fs.rmSync(path.resolve(process.cwd(), audioPath))
}

main()

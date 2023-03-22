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
  const audioPath = videoPath.replace(/.(\w+)$/, '.mp3')
  const srtOutputPath = arguPath.replace('.mp4', '.srt')
  const chunkSize = 24 // MB
  let fullSrtContent = ''

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
    console.log(c.blue(`  已轉換音檔：${audioPath}`))
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
      const chunkFilePath = audioPath.replace(/.(\w+)$/, `_chunk_${index}.$1`)
      const chunkSrtFilePath = videoPath.replace(/.(\w+)$/, `_chunk_${index}.srt`)
      const chunkSrtOutputFilePath = videoPath.replace(/.(\w+)$/, `_chunk_${index}_output.srt`)
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
        console.log(c.blue(`  已分割影片：${chunkFilePath}`))
      }

      // upload to whisper
      const stream = fs.createReadStream(path.resolve(process.cwd(), chunkFilePath))
      const { data: srt } = await openai.createTranscription(stream, 'whisper-1', undefined, 'srt')
      fs.writeFileSync(path.resolve(process.cwd(), chunkSrtFilePath), srt, {
        encoding: 'utf-8',
      })
      console.log(c.blue(`  已生成字幕：${chunkFilePath}`))

      // move srt time
      await new Promise(resolve => {
        fs.createReadStream(path.resolve(process.cwd(), chunkSrtFilePath))
          .pipe(parse())
          // fix last subtitle time
          .pipe(
            map((node, index) => {
              if (node.type === 'cue') {
                if (node.data.end > (realChunkDuration * 1000)) // 毫秒
                  node.data.end = realChunkDuration * 1000
              }
              return node
            })
          )
          .pipe(resync(startDuration * 1000)) // 毫秒
          .pipe(stringify({ format: 'SRT' }))
          .pipe(fs.createWriteStream(path.resolve(process.cwd(), chunkSrtOutputFilePath)))
          .on('finish', resolve)
      })

      // concat full srt file
      if (fullSrtContent) fullSrtContent += "\n"
      fullSrtContent += fs.readFileSync(path.resolve(process.cwd(), chunkSrtOutputFilePath), {
        encoding: 'utf-8',
      })

      // clear temp files
      if (fs.existsSync(path.resolve(process.cwd(), chunkFilePath)))
        fs.rmSync(path.resolve(process.cwd(), chunkFilePath))
      if (fs.existsSync(path.resolve(process.cwd(), chunkSrtFilePath)))
        fs.rmSync(path.resolve(process.cwd(), chunkSrtFilePath))
      if (fs.existsSync(path.resolve(process.cwd(), chunkSrtOutputFilePath)))
        fs.rmSync(path.resolve(process.cwd(), chunkSrtOutputFilePath))

      console.log(c.blue(`  已處理字幕：${chunkFilePath}`))
    }))
  )

  // save full srt
  fs.writeFileSync(path.resolve(process.cwd(), srtOutputPath), fullSrtContent, {
    encoding: 'utf-8',
  })
  console.log(c.green(`已生成字幕：${srtOutputPath}`))

  // clear temp files
  if (fs.existsSync(path.resolve(process.cwd(), audioPath)))
    fs.rmSync(path.resolve(process.cwd(), audioPath))
}

main()

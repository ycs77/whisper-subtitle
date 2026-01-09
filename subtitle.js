import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import OpenAI from 'openai'
import Bottleneck from 'bottleneck'
import { map, parse, stringify } from 'subtitle'
import c from 'picocolors'
import { exec, getDuration, receive, srtToTxt, printLog, errorLog, assertOpenaiApiKey } from './utils.js'

assertOpenaiApiKey()

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
  if (!videoPath) {
    errorLog('請輸入影片/音檔檔案路徑')
  }
  if (!['.mp4', '.avi', '.mov', '.mp3', '.wav', '.flac'].includes(path.extname(videoPath))) {
    errorLog('請輸入影片/音檔檔案')
  }
  const videoName = path.basename(videoPath)
  const audioPath = videoPath.replace(/.(\w+)$/, '_tmp.mp3')
  const outputPaths = formats.map(format => videoPath.replace(/.(\w+)$/, `.${format}`))
  const chunkSize = 24 // MB
  let fullOutputContents = formats.reduce((contents, format) => {
    contents[format] = ''
    return contents
  }, {})

  // instance
  const limiter = new Bottleneck({ maxConcurrent: 1 })
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  // print info
  printLog(videoName, '媒體')
  printLog(`Formats: ${c.yellow(formats.join(', '))}`)
  printLog(`Language: ${language ? c.yellow(language) : c.dim('未設定')}`)
  printLog(`Custom Prompt: ${
    fs.existsSync(path.resolve(import.meta.dirname, 'prompt.txt'))
      ? c.green('已設定')
      : c.dim('未設定')
  }`)

  // transform video to audio
  if (fs.existsSync(path.resolve(process.cwd(), audioPath))) {
    printLog('音檔已存在', 'warning')
    printLog(`  ${audioPath}`)
  } else {
    printLog('開始轉換音檔...', '音檔')
    printLog(`  ${audioPath}`)
    try {
      await exec('ffmpeg', ['-i', videoPath, audioPath])
    } catch (error) {
      errorLog(error)
    }
    printLog('轉換完成！')
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
        printLog('影片片段已存在', 'warning')
        printLog(`  ${chunkPath}`)
      } else {
        printLog('開始分割音檔...', '分割')
        printLog(`  ${chunkPath}`)
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
        printLog('分割完成！')
      }

      // upload to whisper
      printLog('開始生成片段字幕...', '字幕')
      printLog(`  ${chunkPath}`)
      let prompt
      if (fs.existsSync(path.resolve(import.meta.dirname, 'prompt.txt'))) {
        prompt = fs.readFileSync(path.resolve(import.meta.dirname, 'prompt.txt'), { encoding: 'utf-8' })
      }
      let srt = ''
      try {
        srt = await openai.audio.transcriptions.create({
          model: 'whisper-1',
          file: fs.createReadStream(path.resolve(process.cwd(), chunkPath)),
          language,
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
      printLog('字幕生成完成！')

      // handle subtitle files
      printLog('開始處理片段字幕...', '字幕')
      printLog(`  ${chunkPath}`)
      await Promise.all(
        chunkOutputPaths.map(chunkOutputPath => limiter.schedule(async () => {
          const format = resolveFormatFromPath(chunkOutputPath)
          let chunkContent = ''

          if (format === 'srt') {
            // 1. move srt time
            // 2. remove end period
            chunkContent = await new Promise(resolve => {
              let chunks = ''
              pipeline(
                fs.createReadStream(path.resolve(process.cwd(), chunkOutputPath)),
                parse(),
                map(node => {
                  if (node.type === 'cue') {
                    // fix first subtitle time
                    if (node.data.start < 0)
                      node.data.start = 0

                    // fix last subtitle time
                    if (node.data.end > (realChunkDuration * 1000)) // 毫秒
                      node.data.end = realChunkDuration * 1000

                    // remove end period
                    if (/\.|。$/.test(node.data.text))
                      node.data.text = node.data.text.replace(/\.|。$/, '')
                  }
                  return node
                }),
                stringify({ format: 'SRT' }),
                receive(chunk => chunks += chunk),
              ).then(() => resolve(chunks))
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

      printLog('字幕處理完成！')
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
          let chunks = ''
          // rebuild srt index
          pipeline(
            fs.createReadStream(path.resolve(process.cwd(), outputPath)),
            parse(),
            stringify({ format: 'SRT' }),
            receive(chunk => chunks += chunk),
          ).then(() => resolve(chunks))
        })
        fs.writeFileSync(path.resolve(process.cwd(), outputPath), fullOutputContents[format], {
          encoding: 'utf-8',
        })
      }

      printLog('字幕產生完成！')
      printLog(`  ${outputPath}`)
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

import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import OpenAI from 'openai'
import { parse, stringify, formatTimestamp } from 'subtitle'
import c from 'picocolors'
import { asyncMap, printLog, errorLog, assertOpenaiApiKey } from './utils.js'

assertOpenaiApiKey()

const { argPath, languageFrom, languageTo } = resolveArgs(process.argv)

function resolveArgs(args) {
  const argPath = args[2]

  const languageFromIndex = args.findIndex(v => v === '--from')
  const languageFrom = languageFromIndex !== -1
    ? args[languageFromIndex + 1]
    : process.env.SUBTITLE_LANGUAGE_TRANSLATE_FROM

  const languageToIndex = args.findIndex(v => v === '--to')
  const languageTo = languageToIndex !== -1
    ? args[languageToIndex + 1]
    : process.env.SUBTITLE_LANGUAGE_TRANSLATE_TO

  return { argPath, languageFrom, languageTo }
}

async function main() {
  // vars
  const srtPath = argPath
  if (!srtPath) {
    errorLog('請輸入 srt 檔案路徑')
  }
  if (path.extname(srtPath) !== '.srt') {
    errorLog('請輸入 srt 檔案')
  }
  const srtName = path.basename(srtPath)
  const outputPath = srtPath.replace(/.(\w+)$/, `-${languageTo.toLowerCase().replaceAll(' ', '-')}.$1`)
  const formatOptions = { format: 'SRT' }

  // instance
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  // print info
  printLog(srtPath, '字幕')
  printLog(`Language From: ${c.yellow(languageFrom)}`)
  printLog(`Language To: ${c.yellow(languageTo)}`)
  printLog('開始翻譯字幕...', '翻譯')

  await pipeline(
    fs.createReadStream(path.resolve(process.cwd(), srtPath)),
    parse(),
    asyncMap(async (node, index) => {
      if (node.type === 'cue') {
        printLog(index + 1)
        printLog(`${
          formatTimestamp(node.data.start, formatOptions)
        } --> ${
          formatTimestamp(node.data.end, formatOptions)
        }`)
        printLog(`原文 "${node.data.text}"`)

        const { choices } = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: `Act as a highly proficient translation assistant. Your task is to accurately translate the provided text from ${languageFrom} to ${languageTo}, maintaining the original meaning, tone, and style. Pay special attention to cultural nuances and idiomatic expressions to ensure the translation is contextually appropriate. Additionally, ensure the translation is concise and suitable for subtitle formatting. Add a half-width space between full-width and half-width characters to improve readability.

Source Language: ${languageFrom}
Target Language: ${languageTo}`,
            },
            {
              role: 'user',
              content: node.data.text,
            },
          ],
        })

        if (choices[0].message.content)
          node.data.text = choices[0].message.content

        // remove end period
        if (/\.|。$/.test(node.data.text))
          node.data.text = node.data.text.replace(/\.|。$/, '')

        printLog(`翻譯 "${node.data.text}"`)
        printLog()
      }

      return node
    }),
    stringify(formatOptions),
    fs.createWriteStream(path.resolve(process.cwd(), outputPath)),
  )

  printLog('字幕翻譯完成！')
  printLog(`  ${srtPath}`)
}

main()

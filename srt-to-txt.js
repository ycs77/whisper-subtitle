import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import { generatePrintLog, srtToTxt } from './utils.js'

const argPath = process.argv[2]

async function main() {
  // vars
  const srtPath = argPath
  const srtName = path.basename(srtPath)
  const outputPath = srtPath.replace(/.(\w+)$/, '.txt')

  // utils
  const printLog = generatePrintLog(srtName)

  const content = await srtToTxt(srtPath)
  fs.writeFileSync(path.resolve(process.cwd(), outputPath), content, {
    encoding: 'utf-8',
  })

  printLog(`轉成文字檔 ${outputPath}`, 'success')
}

main()

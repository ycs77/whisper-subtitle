require('dotenv').config()

const path = require('path')
const fs = require('fs')
const c = require('picocolors')
const { srtToTxt } = require('./utils')

const argPath = process.argv[2]

async function main() {
  // vars
  const srtPath = argPath
  const srtName = path.basename(srtPath)
  const outputPath = srtPath.replace(/.(\w+)$/, '.txt')

  // utils
  const print = (message, isSuccessfully) => {
    console.log(
      c.white(c.bgCyan(` ${srtName} `)) +
      (isSuccessfully
        ? c.green(` ${message}`)
        : ` ${message}`)
    )
  }

  const content = await srtToTxt(srtPath)
  fs.writeFileSync(path.resolve(process.cwd(), outputPath), content, {
    encoding: 'utf-8',
  })

  print(`轉成文字檔 ${outputPath}`, true)
}

main()

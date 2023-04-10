const path = require('path')
const fs = require('fs')
const child_process = require('child_process')
const spawn = require('cross-spawn')
const { map, parse } = require('subtitle')

module.exports.getDuration = function (path) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      child_process.exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${path}"`, (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve(parseInt(stdout))
      })
    }, 100)
  })
}

module.exports.exec = function (command, args) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const parts = Array.isArray(args) ? [command, ...args] : command.split(' ')
      const proc = spawn(parts[0], parts.splice(1), {
        stdio: process.argv.includes('--log-spawn') ? 'inherit' : 'ignore',
      })

      proc.on('error', error => {
        reject(error)
      })

      proc.on('close', () => {
        resolve()
      })
    }, 100)
  })
}

module.exports.srtToTxt = function (srtFile) {
  return new Promise((resolve, reject) => {
    const lines = []
    fs.createReadStream(path.resolve(process.cwd(), srtFile))
      .pipe(parse())
      .pipe(map(node => {
        if (node.type === 'cue') {
          lines.push(node.data.text)
        }
        return node
      }))
      .on('data', () => {})
      .on('error', error => {
        reject(error)
      })
      .on('end', () => {
        resolve(lines.join('\n'))
      })
  })
}

module.exports.errorLog = function (error) {
  const logFile = 'whisper-subtitle-error.log'
  const content = `Date: ${new Date().toLocaleString()}:\n\nError:\n${error.stack ?? error.message}\n`

  fs.writeFileSync(path.resolve(process.cwd(), logFile), content, {
    encoding: 'utf-8',
  })

  process.exit(1)
}

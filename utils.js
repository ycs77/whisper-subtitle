const path = require('path')
const fs = require('fs')
const child_process = require('child_process')
const spawn = require('cross-spawn')
const { map, parse, stringify } = require('subtitle')

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
  return new Promise(resolve => {
    setTimeout(() => {
      const parts = Array.isArray(args) ? [command, ...args] : command.split(' ')
      const proc = spawn(parts[0], parts.splice(1), {
        stdio: process.argv.includes('--log-spawn') ? 'inherit' : 'ignore',
      })

      proc.on('close', () => {
        resolve()
      })
    }, 100)
  })
}

module.exports.srtToTxt = function (srtFile) {
  return new Promise(resolve => {
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
      .on('end', () => {
        resolve(lines.join('\n'))
      })
  })
}

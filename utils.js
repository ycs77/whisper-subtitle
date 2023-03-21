const { exec } = require('child_process')
const spawn = require('cross-spawn')

module.exports.getDuration = function (path) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${path}`
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve(parseInt(stdout))
      })
    }, 100)
  })
}

module.exports.exec = function (command) {
  return new Promise(resolve => {
    setTimeout(() => {
      const parts = command.split(' ')
      const proc = spawn(parts[0], parts.splice(1), {
        stdio: process.argv.includes('--log-spawn') ? 'inherit' : 'ignore',
      })

      proc.on('close', () => {
        resolve()
      })
    }, 100)
  })
}

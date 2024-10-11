import path from 'node:path'
import fs from 'node:fs'
import child_process from 'node:child_process'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import spawn from 'cross-spawn'
import { filter, map, parse } from 'subtitle'
import c from 'picocolors'

export function getDuration(path) {
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

export function exec(command, args) {
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

/**
 * @param {(node: import('subtitle').Node, index: number) => Promise<any>} mapper
 * @returns {Transform}
 */
export function asyncMap(mapper) {
  let index = 0

  return new Transform({
    objectMode: true,
    autoDestroy: false,
    async transform(chunk, _encoding, callback) {
      callback(null, await mapper(chunk, index++))
    },
  })
}

/**
 * @param {(chunk: any) => void} callback
 * @returns {Writable}
 */
export function receive(callback) {
  return new Writable({
    objectMode: true,
    write(chunk, _encoding, done) {
      callback(chunk)
      done()
    },
  })
}

export async function srtToTxt(srtFile) {
  let chunks = ''

  await pipeline(
    fs.createReadStream(path.resolve(process.cwd(), srtFile)),
    parse(),
    filter(node => node.type === 'cue'),
    map(node => node.data.text),
    receive(chunk => chunks += `${chunk}\n`),
  )

  return chunks
}

export function generatePrintLog(item) {
  return function printLog(message = '', type = null) {
    console.log(
      c.white(c.bgCyan(` ${item} `)) +
      (
        type === 'success'
          ? c.green(` ${message}`)
          : type === 'warning'
            ? c.yellow(` ${message}`)
            : ` ${message}`
      )
    )
  }
}

export function printLog(message, type) {
  let content = c.white(c.bgCyan(` ${videoName} `)) + ' '

  if (type === 'success') content += c.green(message)
  else if (type === 'warning') content += c.yellow(message)
  else content += message

  console.log(content)
}

export function errorLog(error) {
  const logFile = 'whisper-subtitle-error.log'
  let content = `Date: ${new Date().toLocaleString()}:\n\nError:\n`

  if (typeof error === 'string') {
    console.error(`${c.white(c.bgRedBright(' ERROR '))} ${error}`)
    content += `${error}\n`
  } else {
    console.error(error)
    content += `${error.stack ?? error.message}\n`
  }

  fs.writeFileSync(path.resolve(process.cwd(), logFile), content, {
    encoding: 'utf-8',
  })

  process.exit(1)
}

import path from 'node:path'
import fs from 'node:fs'
import child_process from 'node:child_process'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import spawn from 'cross-spawn'
import { filter, map, parse } from 'subtitle'
import c from 'picocolors'

/**
 * @param {string} path
 * @returns {Promise<number>}
 */
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

/**
 * @param {string} command
 * @param {string[] | string} args
 * @returns {Promise<void>}
 */
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

/**
 * @param {string} srtFile
 * @returns {Promise<string>}
 */
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

export function printLog(message = '', type = 'info') {
  const variants = ['info', 'warning']
  let isLabel = !variants.includes(type)

  if (isLabel) {
    console.log(`${c.bgCyan(c.black(` ${type} `))} ${message}`)
  } else if (type === 'info') {
    console.log(`${c.blue(' INFO ')} ${message}`)
  } else if (type === 'warning') {
    console.log(`${c.yellow(' WARN ')} ${message}`)
  }
}

export function errorLog(error) {
  const logFile = 'whisper-subtitle-error.log'
  let content = `Date: ${new Date().toLocaleString()}:\n\nError:\n`

  if (typeof error === 'string') {
    console.error(`${c.bgRedBright(c.white(' ERROR '))} ${error}`)
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

export function assertOpenaiApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(c.red('Error: OPENAI_API_KEY environment variable is not set. Please set it with your OpenAI API key.'))
    process.exit(1)
  }
}

import type { Queue } from 'bullmq'
import type Logger from 'bunyan'

import { range } from 'lodash'
import { recoverPersonalSignature } from 'eth-sig-util'

import { logger as genericLogger } from '../logging'
import config from '../config'

export function verifySignature(data: any, sig: any) {
  return recoverPersonalSignature({ data, sig })
}

export async function timeout(ms: number, log = true) {
  if (log) {
    genericLogger.debug(`starting timeout of ${ms}`)
  }
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Generates a random number from [0, max)
 * @param {number} max the max random number. exclusive
 */
export function getRandomInt(max: number) {
  return Math.floor(Math.random() * max)
}

export function stringifyMap(map: Record<any, any>) {
  return JSON.stringify(Array.from(map.entries()))
}

// Regular expression to check if endpoint is a FQDN. https://regex101.com/r/kIowvx/2
export function isFqdn(url: string) {
  if (config.get('creatorNodeIsDebug')) return true
  const fqdn = new RegExp(
    /(?:^|[ \t])((https?:\/\/)?(?:localhost|[\w-]+(?:\.[\w-]+)+)(:\d+)?(\/\S*)?)/gm
  )
  return fqdn.test(url)
}

export async function clearActiveJobs(queue: Queue, queueLogger: Logger) {
  const oldActiveJobs = await queue.getJobs(['active'])
  queueLogger.info(
    `Removing ${oldActiveJobs.length} leftover active jobs from ${queue.name}`
  )
  return Promise.allSettled(oldActiveJobs.map((job) => job.remove()))
}

export function getCharsInRange(startChar: string, endChar: string): string[] {
  return range(startChar.charCodeAt(0), endChar.charCodeAt(0) + 1).map(
    (charCode) => String.fromCharCode(charCode)
  )
}

export function getCharsInRanges(...ranges: string[]): string[] {
  const charsInRanges = []
  for (const range of ranges) {
    charsInRanges.push(...getCharsInRange(range.charAt(0), range.charAt(1)))
  }
  return charsInRanges
}

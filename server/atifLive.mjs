import OSS from 'ali-oss'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { BufferCache } from './bufferCache.mjs'

const STREAM_VERSION = 'osworld-atif-stream/v1'
const MANIFEST_VERSION = 'osworld-atif-stream-manifest/v1'
const MAX_LINES = 1_000_000
const MAX_CHUNKS = 10_000
const cache = new BufferCache()

function parseEnv(text) {
  const values = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

async function ossSettings() {
  let fileValues = {}
  if (process.env.REPLAY_OSS_ENV_FILE) {
    fileValues = parseEnv(await readFile(process.env.REPLAY_OSS_ENV_FILE, 'utf8'))
  }
  const value = (name) => process.env[name] || fileValues[name] || ''
  const settings = {
    accessKeyId: value('OSS_ACCESS_KEY_ID'),
    accessKeySecret: value('OSS_ACCESS_KEY_SECRET'),
    bucket: value('OSS_BUCKET'),
    endpoint: value('OSS_ENDPOINT'),
    region: value('OSS_REGION'),
    prefix: value('OSS_PREFIX').replace(/^\/+|\/+$/g, ''),
  }
  const missing = Object.entries(settings)
    .filter(([name, item]) => name !== 'prefix' && !item)
    .map(([name]) => name)
  if (missing.length) throw new Error(`Replay OSS configuration is missing ${missing.join(', ')}`)
  return settings
}

let settingsPromise
let clientPromise
function getSettings() {
  return settingsPromise ??= ossSettings()
}
function getClient() {
  return clientPromise ??= getSettings().then((settings) => new OSS({
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    accessKeySecret: settings.accessKeySecret,
    bucket: settings.bucket,
    endpoint: settings.endpoint,
    authorizationV4: true,
  }))
}

function validSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
}

function notFound(error) {
  return error?.status === 404 || error?.statusCode === 404 || error?.code === 'NoSuchKey'
}

async function getObject(key) {
  const client = await getClient()
  try {
    const result = await client.get(key)
    return Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content)
  } catch (error) {
    if (notFound(error)) return null
    throw error
  }
}

export function parseManifest(body) {
  let value
  try { value = JSON.parse(body.toString('utf8')) }
  catch { throw new Error('ATIF live manifest is not valid JSON') }
  if (value?.trace_format !== 'atif-stream'
      || value?.stream_schema_version !== STREAM_VERSION
      || value?.manifest_schema_version !== MANIFEST_VERSION
      || !Number.isInteger(value.total_lines)
      || value.total_lines < 0
      || value.total_lines > MAX_LINES
      || !Array.isArray(value.chunks)
      || value.chunks.length > MAX_CHUNKS) {
    throw new Error('ATIF live manifest violates its protocol')
  }
  let cursor = 0
  let previousStart = -1
  for (const descriptor of value.chunks) {
    if (!Number.isInteger(descriptor?.start) || descriptor.start <= previousStart
        || descriptor.start > cursor
        || !Number.isInteger(descriptor?.count) || descriptor.count < 1
        || descriptor.start + descriptor.count <= cursor
        || descriptor.start + descriptor.count > MAX_LINES) {
      throw new Error('ATIF live manifest has a non-contiguous chunk list')
    }
    previousStart = descriptor.start
    cursor = descriptor.start + descriptor.count
  }
  if (value.total_lines > cursor || (value.chunks.length && value.total_lines <= previousStart)) {
    throw new Error('ATIF live manifest total_lines does not match its chunks')
  }
  return value
}

export function parseChunk(body, descriptor) {
  const records = body.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  if (records.length !== descriptor.count || records.some((record) => (
    record?.trace_format !== 'atif-stream' || record?.stream_schema_version !== STREAM_VERSION
  ))) {
    throw new Error('ATIF live chunk violates its manifest')
  }
  return records
}

// Older uploaders included records past their dependency-ready boundary, then
// published them again in the next chunk. Only identical, sequenced overlaps
// are recoverable; gaps and conflicting records must still fail closed.
export function assembleRecords(manifest, chunks) {
  const records = []
  let duplicates = 0
  for (let index = 0; index < manifest.chunks.length; index++) {
    const descriptor = manifest.chunks[index]
    const chunk = chunks[index]
    if (!chunk || chunk.length !== descriptor.count) throw new Error('ATIF live chunk violates its manifest')
    for (let offset = 0; offset < chunk.length; offset++) {
      const position = descriptor.start + offset
      const record = chunk[offset]
      if (position >= manifest.total_lines) {
        if (record.stream_sequence !== position + 1) throw new Error('ATIF live unpublished tail has an invalid sequence')
        continue // Never expose records beyond the published, dependency-ready cursor.
      }
      if (position < records.length) {
        if (record.stream_sequence !== position + 1 || !isDeepStrictEqual(records[position], record)) {
          throw new Error('ATIF live chunks contain conflicting overlapping records')
        }
        duplicates++
      } else {
        if (position !== records.length) throw new Error('ATIF live chunks contain a gap')
        records.push(record)
      }
    }
  }
  if (records.length !== manifest.total_lines) throw new Error('ATIF live records do not match total_lines')
  return { records, duplicates }
}

function chunkName(root, descriptor) {
  const start = String(descriptor.start).padStart(12, '0')
  const end = String(descriptor.start + descriptor.count).padStart(12, '0')
  return `${root}/trajectory-tail.jsonl.chunks/${start}-${end}.jsonl`
}

export async function loadChunks(manifest, root, readObject = getObject, bufferCache = cache) {
  return Promise.all(manifest.chunks.map(async (descriptor) => {
    const name = chunkName(root, descriptor)
    const cached = bufferCache.get(name)
    if (cached) return parseChunk(cached, descriptor)
    const body = await readObject(name)
    if (!body) throw new Error(`ATIF live chunk is missing: ${descriptor.start}`)
    const records = parseChunk(body, descriptor)
    bufferCache.set(name, body)
    return records
  }))
}

export async function readAtifLive(run, task, after = 0) {
  if (!validSegment(run) || !validSegment(task)) {
    return { status: 400, body: { error: 'Invalid run or task identifier' } }
  }
  if (!Number.isInteger(after) || after < 0 || after > MAX_LINES) {
    return { status: 400, body: { error: 'Invalid ATIF live cursor' } }
  }
  const settings = await getSettings()
  const root = [settings.prefix, 'harness', run, 'tasks', task].filter(Boolean).join('/')
  const manifestBody = await getObject(`${root}/trajectory-tail.meta.json`)
  if (!manifestBody) return { status: 404, body: { error: 'ATIF live stream not found' } }
  const manifest = parseManifest(manifestBody)
  const chunks = await loadChunks(manifest, root)
  const { records, duplicates } = assembleRecords(manifest, chunks)
  const startLine = after <= records.length ? after : 0
  return {
    status: 200,
    body: {
      trace_format: manifest.trace_format,
      stream_schema_version: manifest.stream_schema_version,
      total_lines: manifest.total_lines,
      start_line: startLine,
      terminal: Boolean(manifest.terminal),
      stream: { ...manifest.stream, ...(duplicates ? { recovered_duplicate_records: duplicates } : {}) },
      records: records.slice(startLine),
    },
  }
}

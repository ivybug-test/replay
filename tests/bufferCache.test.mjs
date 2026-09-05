import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BufferCache } from '../server/bufferCache.mjs'
import { assembleRecords, loadChunks, parseManifest } from '../server/atifLive.mjs'

test('payload budget evicts least recently used chunks; oversized payloads are not retained', () => {
  const cache = new BufferCache({ maxBytes: 10, sweepMs: 0 })
  cache.set('a', Buffer.alloc(6))
  cache.set('b', Buffer.alloc(4))
  cache.get('a')
  cache.set('c', Buffer.alloc(4))
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.bytes, 10)
  cache.set('large', Buffer.alloc(11))
  assert.equal(cache.get('large'), undefined)
  assert.equal(cache.bytes, 10)
  cache.set('a', Buffer.alloc(2))
  assert.equal(cache.bytes, 6)
  cache.close()
})

test('tiny slices do not retain large parent allocations; entry count is bounded', () => {
  const cache = new BufferCache({ maxBytes: 100, maxEntries: 2, sweepMs: 0 })
  const parent = Buffer.alloc(1024 * 1024)
  cache.set('slice', parent.subarray(10, 20))
  assert.equal(cache.get('slice').buffer.byteLength, 10)
  cache.set('b', Buffer.alloc(0))
  cache.set('c', Buffer.alloc(0))
  assert.equal(cache.get('slice'), undefined)
  assert.equal(cache.entries.size, 2)
  cache.close()
})

test('idle TTL is refreshed on access and expired entries are never returned', () => {
  let now = 0
  const cache = new BufferCache({ ttlMs: 100, now: () => now, sweepMs: 0 })
  cache.set('a', Buffer.alloc(10))
  now = 90
  assert.ok(cache.get('a'))
  now = 189
  cache.prune()
  assert.equal(cache.bytes, 10)
  now = 190
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.bytes, 0)
  cache.close()
})

test('background sweep releases idle entries without another request', async () => {
  let now = 0
  const cache = new BufferCache({ ttlMs: 10, sweepMs: 5, now: () => now })
  try {
    cache.set('a', Buffer.alloc(10))
    now = 11
    await delay(30)
    assert.equal(cache.bytes, 0)
    assert.equal(cache.entries.size, 0)
  } finally { cache.close() }
})

test('whole trajectory remains correct when chunks are evicted or too large to cache', async () => {
  const cache = new BufferCache({ maxBytes: 300, sweepMs: 0 })
  const descriptors = [0, 1, 2].map(start => ({ start, count: 1 }))
  const manifest = parseManifest(Buffer.from(JSON.stringify({
    trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
    manifest_schema_version: 'osworld-atif-stream-manifest/v1', chunks: descriptors, total_lines: 3,
  })))
  const records = descriptors.map(({ start }) => ({
    trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
    stream_sequence: start + 1, message: 'x'.repeat(start === 1 ? 500 : 30),
  }))
  let reads = 0
  const readObject = async key => {
    reads++
    const start = Number(key.split('/').at(-1).split('-')[0])
    return Buffer.from(JSON.stringify(records[start]))
  }
  for (let i = 0; i < 2; i++) {
    const chunks = await loadChunks(manifest, 'test', readObject, cache)
    assert.deepEqual(assembleRecords(manifest, chunks).records, records)
    assert.ok(cache.bytes <= 300)
  }
  assert.ok(reads > 3, 'evicted/oversized chunks must be fetched again')
  assert.ok([...cache.entries.values()].every(entry => Buffer.isBuffer(entry.body)))
  cache.close()
})

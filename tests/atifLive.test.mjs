import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleRecords, parseChunk, parseManifest } from '../server/atifLive.mjs'

const record = (sequence) => ({
  trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
  stream_sequence: sequence, op: 'upsert_step', step: { message: `Step ${sequence}` },
})
const manifest = (chunks, total_lines) => parseManifest(Buffer.from(JSON.stringify({
  trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
  manifest_schema_version: 'osworld-atif-stream-manifest/v1', chunks, total_lines,
})))
const chunk = (values, descriptor) => parseChunk(Buffer.from(values.map(JSON.stringify).join('\n')), descriptor)

test('overlapping upload boundaries recover only identical records and preserve incremental cursors', () => {
  const descriptors = [{ start: 0, count: 3 }, { start: 2, count: 3 }, { start: 4, count: 2 }]
  const parts = [[1, 2, 3], [3, 4, 5], [5, 6]].map((seqs, i) => chunk(seqs.map(record), descriptors[i]))
  const input = manifest(descriptors, 6)
  const result = assembleRecords(input, parts)
  assert.deepEqual(result.records.map(r => r.stream_sequence), [1, 2, 3, 4, 5, 6])
  assert.equal(result.duplicates, 2)
  assert.deepEqual(result.records.slice(4).map(r => r.stream_sequence), [5, 6])
  parts[1][0].step.message = 'Conflicting duplicate'
  assert.throws(() => assembleRecords(input, parts), /conflicting overlapping/)
  parts[1][0] = record(99)
  assert.throws(() => assembleRecords(input, parts), /conflicting overlapping/)
})

test('unpublished tails remain hidden until the dependency-ready cursor advances', () => {
  const first = manifest([{ start: 0, count: 3 }], 2)
  assert.deepEqual(assembleRecords(first, [[1, 2, 3].map(record)]).records.map(r => r.stream_sequence), [1, 2])
  const next = manifest([{ start: 0, count: 3 }, { start: 2, count: 2 }], 4)
  const result = assembleRecords(next, [[1, 2, 3].map(record), [3, 4].map(record)])
  assert.deepEqual(result.records.slice(2).map(r => r.stream_sequence), [3, 4])
  assert.throws(() => assembleRecords(first, [[1, 2, 99].map(record)]), /invalid sequence/)
})

test('ordinary streams still work and gaps, reversed ranges and malformed chunks are rejected', () => {
  const input = manifest([{ start: 0, count: 2 }, { start: 2, count: 1 }], 3)
  assert.deepEqual(assembleRecords(input, [[1, 2].map(record), [3].map(record)]), {
    records: [1, 2, 3].map(record), duplicates: 0,
  })
  assert.deepEqual(assembleRecords(manifest([], 0), []), { records: [], duplicates: 0 })
  for (const descriptors of [
    [{ start: 1, count: 1 }],
    [{ start: 0, count: 2 }, { start: 3, count: 1 }],
    [{ start: 0, count: 3 }, { start: 2, count: 1 }],
    [{ start: 0, count: 2 }, { start: 0, count: 3 }],
  ]) assert.throws(() => manifest(descriptors, 4), /non-contiguous/)
  assert.throws(() => manifest([{ start: 0, count: 1 }], 2), /total_lines/)
  assert.throws(() => chunk([record(1)], { count: 2 }), /violates its manifest/)
})

import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { proxyApi } from '../server/proxyApi.mjs'

async function fixture(t, handler) {
  const peers = new Set()
  const backend = http.createServer(handler)
  backend.on('connection', socket => {
    peers.add(socket)
    socket.once('close', () => peers.delete(socket))
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const url = new URL(`http://127.0.0.1:${backend.address().port}`)
  const proxy = http.createServer((req, res) => proxyApi(req, res, url))
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(async () => {
    proxy.closeAllConnections()
    backend.closeAllConnections()
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => backend.close(resolve))])
  })
  return { backend, peers, url: `http://127.0.0.1:${proxy.address().port}/api/probe` }
}

async function expectNoPeers(peers) {
  for (let i = 0; i < 100 && peers.size; i++) await delay(10)
  assert.equal(peers.size, 0, 'cancelled clients must not leave backend sockets open')
}

test('repeated mid-download cancellation cleans up every upstream connection', { timeout: 5000 }, async t => {
  const { url, peers } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-length': 8 * 1024 * 1024 })
    const chunk = Buffer.alloc(64 * 1024)
    let sent = 0
    const write = () => {
      while (sent < 8 * 1024 * 1024) {
        sent += chunk.length
        if (!res.write(chunk)) { res.once('drain', write); return }
      }
      res.end()
    }
    write()
  })
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve, reject) => {
      const req = http.get(url, res => {
        res.on('error', () => {})
        res.once('data', () => { res.destroy(); resolve() })
      })
      req.once('error', reject)
    })
  }
  await expectNoPeers(peers)
})

test('client cancellation before backend headers also closes the backend request', { timeout: 5000 }, async t => {
  const { url, backend, peers } = await fixture(t, () => {})
  const received = once(backend, 'request')
  const req = http.get(url)
  req.on('error', () => {})
  await received
  req.destroy()
  await expectNoPeers(peers)
})

test('complete responses and request bodies still pass through intact', { timeout: 5000 }, async t => {
  const { url } = await fixture(t, async (req, res) => {
    const parts = []
    for await (const part of req) parts.push(part)
    res.writeHead(201, { 'content-type': 'text/plain', 'x-probe': 'ok' })
    res.end(Buffer.concat(parts))
  })
  const response = await fetch(url, { method: 'POST', body: 'hello proxy' })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-probe'), 'ok')
  assert.equal(await response.text(), 'hello proxy')
})

test('backend failure during a response closes the client without an unhandled error', { timeout: 5000 }, async t => {
  const { url } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-length': 10000 })
    res.write('partial')
    setTimeout(() => res.destroy(), 20)
  })
  const response = await fetch(url)
  await assert.rejects(response.text())
})

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyApi } from './server/proxyApi.mjs'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const staticRoot = path.resolve(projectRoot, process.env.REPLAY_STATIC_ROOT || 'dist')
const host = process.env.REPLAY_HOST || '0.0.0.0'
const port = Number(process.env.REPLAY_PORT || '18768')
const backend = new URL(process.env.REPLAY_BACKEND_URL || 'http://127.0.0.1:18769')

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid REPLAY_PORT: ${process.env.REPLAY_PORT}`)
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
])

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text)
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function resolveStaticFile(pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) }
  catch { return null }
  const relative = decoded.replace(/^\/+/, '')
  const candidate = path.resolve(staticRoot, relative || 'index.html')
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) return null
  try {
    const info = await stat(candidate)
    if (info.isFile()) return { file: candidate, size: info.size }
  } catch { /* SPA fallback below */ }
  const fallback = path.join(staticRoot, 'index.html')
  const info = await stat(fallback)
  return { file: fallback, size: info.size }
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed')
    return
  }
  let resolved
  try { resolved = await resolveStaticFile(pathname) }
  catch {
    sendText(response, 503, 'Replay has not been built yet.')
    return
  }
  if (!resolved) {
    sendText(response, 404, 'Not found')
    return
  }
  const isIndex = resolved.file.endsWith(`${path.sep}index.html`)
  response.writeHead(200, {
    'content-type': contentTypes.get(path.extname(resolved.file).toLowerCase()) || 'application/octet-stream',
    'content-length': resolved.size,
    'cache-control': isIndex ? 'no-cache' : pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(resolved.file).pipe(response)
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://replay.local')
  if (url.pathname === '/healthz') {
    sendText(response, 200, 'ok\n')
    return
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    proxyApi(request, response, backend)
    return
  }
  void serveStatic(request, response, url.pathname)
})

server.listen(port, host, () => {
  console.log(`Replay listening on http://${host}:${port}; API backend ${backend.origin}`)
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  const forceExit = setTimeout(() => {
    server.closeAllConnections?.()
    process.exit(1)
  }, 5000)
  forceExit.unref()
  server.closeIdleConnections?.()
  server.close((error) => {
    clearTimeout(forceExit)
    if (error) {
      console.error(error)
      process.exit(1)
    }
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

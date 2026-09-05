import http from 'node:http'

const hopByHopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function safeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !hopByHopHeaders.has(name.toLowerCase())))
}

export function proxyApi(request, response, backend) {
  const target = new URL(request.url, backend)
  const headers = safeHeaders(request.headers)
  headers.host = target.host
  headers['x-forwarded-host'] = request.headers.host || ''
  headers['x-forwarded-proto'] = 'http'

  let upstreamResponse
  const upstream = http.request(target, { method: request.method, headers }, (incoming) => {
    upstreamResponse = incoming
    incoming.on('error', (error) => response.destroy(error))
    if (response.destroyed) {
      incoming.destroy()
      upstream.destroy()
      return
    }
    response.writeHead(incoming.statusCode || 502, safeHeaders(incoming.headers))
    incoming.pipe(response)
  })
  const cancel = () => {
    request.unpipe(upstream)
    upstreamResponse?.destroy()
    upstream.destroy()
  }
  // GET requests are already complete while the response body is downloading.
  // Request 'aborted' alone therefore misses page navigation / download aborts.
  response.once('close', () => {
    if (!response.writableFinished) cancel()
  })
  response.once('error', cancel)
  request.once('aborted', cancel)
  upstream.setTimeout(0)
  upstream.on('error', (error) => {
    if (response.destroyed) return
    if (response.headersSent) {
      response.destroy(error)
    } else {
      const body = JSON.stringify({ error: 'Replay backend unavailable', detail: error.message })
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
      response.end(body)
    }
  })
  request.pipe(upstream)
}

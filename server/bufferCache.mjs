// Bound retained payload bytes exactly, rather than estimating parsed JS heaps.
export class BufferCache {
  constructor({ maxBytes = 128 * 1024 * 1024, maxEntries = 4096,
    ttlMs = 120_000, sweepMs = 30_000, now = () => performance.now() } = {}) {
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.now = now
    this.entries = new Map()
    this.bytes = 0
    this.timer = sweepMs > 0 ? setInterval(() => this.prune(), sweepMs) : null
    this.timer?.unref()
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.bytes -= entry.body.byteLength
    this.entries.delete(key)
  }

  prune() {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) this.delete(key)
    }
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= this.now()) {
      this.delete(key)
      return undefined
    }
    entry.expires = this.now() + this.ttlMs
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.body
  }

  set(key, body) {
    if (!Buffer.isBuffer(body)) throw new TypeError('BufferCache only accepts Buffers')
    this.delete(key)
    if (body.byteLength > this.maxBytes || this.maxEntries < 1) return
    this.prune()
    while (this.entries.size && (this.bytes + body.byteLength > this.maxBytes
      || this.entries.size >= this.maxEntries)) {
      this.delete(this.entries.keys().next().value)
    }
    // A small Buffer view may keep an arbitrarily large backing allocation alive.
    // Use an unpooled owned allocation so accounted bytes match retained payloads.
    const owned = Buffer.allocUnsafeSlow(body.byteLength)
    body.copy(owned)
    this.entries.set(key, { body: owned, expires: this.now() + this.ttlMs })
    this.bytes += owned.byteLength
  }

  close() {
    clearInterval(this.timer)
    this.entries.clear()
    this.bytes = 0
  }
}

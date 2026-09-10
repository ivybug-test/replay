// A live run whose ATIF stream is broken or not yet published must say so and
// then recover on its own, without falling back to a second representation of
// the same trace (/api/agent-work).
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.REPLAY_TEST_URL ?? 'http://127.0.0.1:18768'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = [], requested = new Set()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requested.add(url.pathname)
  })
  let recovered = false
  await page.route('**/api/*', async route => {
    const url = new URL(route.request().url())
    const responses = {
      '/api/batch': { batch: { batch_id: 'recovery-test', configuration: {}, tasks: [{ key: 'task', task_id: '003', status: 'running' }] } },
      '/api/window': { duration_ms: 1000, terminal: false, timeline: { agent: [], desktop: [] } },
      '/api/agent-work': { terminal: false, duration_ms: 1000, agents: [], items: [] },
      '/api/atif-live': recovered ? {
        trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
        start_line: 0, total_lines: 1, terminal: false,
        records: [{
          trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
          stream_sequence: 1, trajectory_id: 'main', op: 'append_step',
          step: { step_id: 1, source: 'agent', message: 'Recovered trajectory step' },
        }],
      } : { error: 'ATIF live stream unavailable' },
    }
    const body = responses[url.pathname]
    await route.fulfill({
      status: url.pathname === '/api/atif-live' && !recovered ? 502 : body ? 200 : 404,
      contentType: 'application/json', body: JSON.stringify(body ?? {}),
    })
  })
  await page.goto(`${base}/live/runs/recovery-test/tasks/task`)
  await page.getByText('Failed to prepare trajectory', { exact: false }).waitFor()
  assert.equal(await page.getByText('metrics-only', { exact: false }).count(), 0)
  recovered = true
  await page.locator('[data-step-index="0"]').waitFor()
  assert.match(await page.locator('[data-step-index="0"]').innerText(), /Recovered trajectory step/)
  await page.waitForFunction(() => !document.body.innerText.includes('Failed to prepare trajectory'))
  assert.ok(!requested.has('/api/agent-work'), 'A live run must not read a second trace representation')
  assert.deepEqual(errors, [])
  console.log('PASS corrupt live data reports an error and automatically recovers when valid records arrive')
} finally {
  await browser.close()
}

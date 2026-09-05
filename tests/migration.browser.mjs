// Real read-only integration against the isolated standalone backend deployment.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const base = process.env.REPLAY_TEST_URL || 'http://127.0.0.1:18770'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  page.setDefaultTimeout(60000)
  const errors = [], failures = [], requested = new Set()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requested.add(url.pathname)
  })
  page.on('response', response => {
    if (response.url().includes('/api/') && response.status() >= 500) failures.push(`${new URL(response.url()).pathname}: ${response.status()}`)
  })
  const health = await (await page.request.get(`${base}/api/health`)).json()
  assert.deepEqual(health.services_configured, { catalog: true, replay: true })
  await page.goto(`${base}/tasks/osworld-v2-003`)
  const history = page.getByTestId('oss-task-runs')
  await history.locator('tbody tr').first().waitFor()
  const before = await history.locator('tbody tr').count()
  assert.ok(before > 0)
  const more = history.getByRole('button', { name: 'Load more', exact: true })
  if (await more.count()) {
    await more.click()
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="oss-task-runs"] tbody tr').length > count, before)
  }
  console.log('PASS real task 003 history and pagination:', await history.locator('tbody tr').count(), 'executions')
  const firstHref = await history.getByRole('link', { name: 'View trajectory →' }).first().getAttribute('href')
  assert.match(firstHref, /^\/live\/runs\/[^/]+\/tasks\/[^/]+$/)
  await history.getByLabel('Execution status').selectOption('failed')
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid="oss-task-runs"] tbody tr')]
    return rows.length > 0 && rows.every(row => row.children[3].textContent === 'failed')
  })
  console.log('PASS real task-history filtering and execution links')

  for (const [kind, run, task] of [
    ['native', '20260904T083833Z-execution-state-p1-n14-auto-goal-003-smoke', '0001-003'],
    ['legacy', '20260826T015622Z-e2e-fix2', '0001-002'],
    ['live', '20260905T041424Z-planner-state-003-smoke', '0001-003'],
  ]) {
    await page.goto(`${base}/live/runs/${run}/tasks/${task}`)
    await page.locator('[data-step-index]').first().waitFor()
    const image = page.locator('img[src*="/api/frame"], img[src*="/api/atif-media"]')
    await image.first().waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('img[src*="/api/frame"], img[src*="/api/atif-media"]')]
      .some(img => img.complete && img.naturalWidth > 0))
    if (kind === 'live') {
      await page.waitForResponse(response => response.url().includes('/api/atif-live?') && new URL(response.url()).searchParams.get('after') !== '0', { timeout: 60000 })
    }
    console.log('PASS', kind, 'trajectory, images and', kind === 'live' ? 'incremental refresh' : 'rendering')
  }
  assert.ok(requested.has('/api/task-runs'))
  assert.ok(requested.has('/api/atif-live'))
  assert.ok(!requested.has('/api/agent-work'), 'Standalone frontend must consume normalized ATIF directly')
  assert.deepEqual(failures, [])
  assert.deepEqual(errors, [])
  console.log('PASS no legacy Agent Work requests, API failures or browser exceptions')
} finally { await browser.close() }

// Real read-only integration against the isolated standalone backend deployment.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const base = process.env.REPLAY_TEST_URL || 'http://127.0.0.1:18768'
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
  assert.deepEqual(health.services_configured, { catalog: true, replay: true, analysis: true, cohorts: true })
  await page.goto(`${base}/overview`)
  await page.getByRole('heading', { name: 'OSWorld model leaderboard' }).waitFor()
  await page.locator('table tbody tr').first().waitFor()
  assert.ok(await page.locator('table tbody tr').count() > 0)
  assert.match(await page.locator('table tbody tr').first().innerText(), /stateact/)
  console.log('PASS indexed OSWorld leaderboard')
  await page.goto(`${base}/tasks`)
  const indexedTask = page.locator('a[href="/tasks/osworld-v2-003"]')
  await indexedTask.waitFor()
  await page.waitForFunction(() => {
    const card = document.querySelector('a[href="/tasks/osworld-v2-003"]')
    return card && /\d+ runs/.test(card.textContent || '') && !card.textContent?.includes('no runs')
  })
  assert.match(await indexedTask.innerText(), /\d+ runs/)
  console.log('PASS indexed task statistics')
  await page.goto(`${base}/live`)
  const dateFilter = page.getByLabel('Filter runs by date')
  const statusFilter = page.getByLabel('Filter runs by status')
  await dateFilter.waitFor()
  await statusFilter.waitFor()
  await page.waitForFunction(() => /^\d{4}-\d{2}-\d{2}$/.test(document.querySelector('[aria-label="Filter runs by date"]')?.value || ''))
  const latestDate = await dateFilter.inputValue()
  assert.match(latestDate, /^\d{4}-\d{2}-\d{2}$/)
  await statusFilter.click()
  const statusOptions = page.getByRole('option')
  assert.deepEqual(await statusOptions.evaluateAll(options => options.map(option => option.dataset.statusValue)),
    ['', 'running', 'interrupted', 'completed'])
  const firstStatus = await page.getByTestId('live-run-card').first().getAttribute('data-run-status')
  assert.ok(['running', 'interrupted', 'completed'].includes(firstStatus))
  await page.locator(`[role="option"][data-status-value="${firstStatus}"]`).click()
  await page.waitForFunction(status => {
    const cards = [...document.querySelectorAll('[data-testid="live-run-card"]')]
    return cards.length > 0 && cards.every(card => card.getAttribute('data-run-status') === status)
  }, firstStatus)
  assert.equal(new URL(page.url()).searchParams.get('status'), firstStatus)
  await statusFilter.click()
  await page.locator('[role="option"][data-status-value=""]').click()
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('status'))
  console.log('PASS live catalog status filter')
  const historicalResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/runs' && url.searchParams.get('date') === '2026-09-04'
  })
  await dateFilter.fill('2026-09-04')
  await historicalResponse
  await page.locator('a[href^="/live/runs/"]').first().waitFor()
  assert.equal(new URL(page.url()).searchParams.get('date'), '2026-09-04')
  assert.equal(await dateFilter.inputValue(), '2026-09-04')
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForFunction(expected => !new URL(location.href).searchParams.has('date')
    && document.querySelector('[aria-label="Filter runs by date"]')?.value === expected, latestDate)
  assert.equal(await dateFilter.inputValue(), latestDate)
  console.log('PASS live catalog date filter and latest-date reset')

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

  await page.goto(`${base}/aft-reports`)
  const taxonomyToggle = page.getByRole('button', { name: /Long-horizon harness taxonomy/ })
  await taxonomyToggle.waitFor()
  assert.equal(await taxonomyToggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('[data-testid="aft-taxonomy"] [data-taxonomy-row]').count(), 0)
  await taxonomyToggle.click()
  assert.equal(await taxonomyToggle.getAttribute('aria-expanded'), 'true')
  const taxonomyRows = page.locator('[data-testid="aft-taxonomy"] [data-taxonomy-row]')
  assert.equal(await taxonomyRows.count(), 8)
  assert.equal(await page.locator('[data-taxonomy-detail]').count(), 0)
  assert.match(await page.locator('body').innerText(), /8 \/ 8/)
  const progressTag = page.locator('[data-taxonomy-row="LHHT-PROG-003"]')
  assert.match(await progressTag.innerText(), /3 supporting/)
  await progressTag.click()
  const progressSources = await page.locator('[data-taxonomy-detail="LHHT-PROG-003"]').innerText()
  assert.match(progressSources, /LongHorizon-Harness/)
  assert.match(progressSources, /structural limitation/)
  assert.doesNotMatch(progressSources, /HarnessRisk/)
  console.log('PASS native AFT taxonomy catalog and its details are collapsed by default')

  await page.goto(`${base}/live/runs/20260906T110316Z-planner-contract-heavy3-smoke/tasks/0001-012`)
  await page.locator('[data-step-index]').first().waitFor()
  await page.getByRole('button', { name: 'AFT', exact: true }).click()
  await page.getByText(/后端分析完成|分析此 Execution/, { exact: false }).first().waitFor()
  console.log('PASS native ATIF task analysis endpoint and panel')

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
  assert.ok(requested.has('/api/task-stats'))
  assert.ok(requested.has('/api/leaderboard'))
  assert.ok(requested.has('/api/analysis-models'))
  assert.ok(requested.has('/api/execution-analysis'))
  assert.ok(requested.has('/api/problem-tags'))
  assert.ok(requested.has('/api/aft-reports'))
  assert.ok(requested.has('/api/atif-live'))
  assert.ok(!requested.has('/api/agent-work'), 'Standalone frontend must consume normalized ATIF directly')
  assert.deepEqual(failures, [])
  assert.deepEqual(errors, [])
  console.log('PASS no legacy Agent Work requests, API failures or browser exceptions')
} finally { await browser.close() }

// Synthetic Harness events only; never changes backend data or OSS.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.REPLAY_TEST_URL ?? 'http://127.0.0.1:18768'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const artifact = { id: 'a1', description: 'Report', requirements: ['Readable report'], file_path: '/tmp/report.txt' }
  const claim = { id: 'v1', artifact_ids: ['a1'], claim: 'Report is readable', reason: 'Inspected saved file',
    evidence: [{ ref: 'verifier:read1', observation: 'Read the saved report' }] }
  const gap = { id: 'g1', artifact_ids: ['a1'], claim: 'Title requires review', reason: 'Not checked', evidence: [] }
  const basis = { id: 'b1', kind: 'basis', artifact_ids: ['a1'], claim: 'The format supports headings',
    reason: 'Needed for formatting', source_files: ['/tmp/format.md'],
    evidence: [{ ref: 'executor:read2', observation: 'Format documentation' }] }
  const lifecycle = (sequence, ms, agent, hoh) => ({ event_type: 'subagent_lifecycle', sequence,
    episode_elapsed_ms: ms, record: { agent, status: 'completed', hoh } })
  const trajectory = { schema_version: 'ATIF-v1.8', trajectory_id: 'root', agent: { name: 'hoh', version: '1' },
    steps: [50, 250, 450].map((ms, index) => ({ step_id: index + 1, source: 'agent', message: `Step ${index + 1}`,
      extra: { osworld_harness: { timing: { clock: 'episode_elapsed_ms', start_ms: ms, end_ms: ms + 10 } } } })),
    extra: { osworld_harness: { schema_version: 'osworld-harness/v1', events: [
      lifecycle(1, 100, 'hoh_planner', { loop: 1, state_revision: 1, planner_output: { artifacts: [artifact],
        task_items: [{ target: { artifact_ids: ['a1'], description: 'Save the complete report' }, preserve: ['Title'], gate: ['Report readable'] }] } }),
      lifecycle(2, 200, 'hoh_verifier', { loop: 1, state_revision: 2, claims: [basis], verification: { verified: [claim], gaps: [gap] } }),
      lifecycle(3, 400, 'hoh_executor', { loop: 2, state_revision: 3, claims: [], invalidated_verified: ['v1'],
        artifact_changes: [{ artifact_id: 'a1', reason: 'file_changed' }] }),
    ] } },
  }
  await page.route('**/api/*', async route => {
    const pathname = new URL(route.request().url()).pathname
    const responses = {
      '/api/batch': { batch: { batch_id: 'hoh-ui-test', batch_name: 'HoH State test', status: 'completed',
        tasks: [{ key: 'task', task_id: 'synthetic', status: 'succeeded' }] } },
      '/api/trajectory': trajectory,
      '/api/window': { duration_ms: 500, terminal: true, timeline: { agent: [], desktop: [] } },
    }
    await route.fulfill({ status: responses[pathname] ? 200 : 404, contentType: 'application/json', body: JSON.stringify(responses[pathname] ?? {}) })
  })
  await page.goto(`${base}/live/runs/hoh-ui-test/tasks/task`)
  await page.getByRole('button', { name: 'State (3)', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Execution State', exact: true })
  assert.match(await panel.innerText(), /not initialized at this position/)
  await page.locator('[data-step-index="1"]').click()
  await panel.getByText('Report is readable', { exact: true }).waitFor()
  assert.match(await panel.innerText(), /Save the complete report/)
  assert.equal(await panel.getByLabel('Target artifacts').innerText(), 'a1')
  assert.match(await panel.innerText(), /Title requires review/)
  const candidates = panel.getByRole('region', { name: 'Candidate claims', exact: true })
  assert.match(await candidates.innerText(), /Unverified/)
  assert.match(await candidates.innerText(), /Execution basis/)
  assert.match(await candidates.innerText(), /\/tmp\/format.md/)
  await candidates.getByText('Evidence · 1', { exact: true }).click()
  assert.ok(await candidates.getByText('Format documentation', { exact: true }).isVisible())
  const verified = panel.getByRole('region', { name: 'Verified', exact: true })
  assert.equal(await verified.getByText(basis.claim).count(), 0)
  await verified.getByText('Evidence · 1', { exact: true }).click()
  assert.ok(await panel.getByText('Read the saved report', { exact: true }).isVisible())
  await page.locator('[data-step-index="2"]').click()
  await panel.getByText('Removed: v1', { exact: true }).waitFor()
  assert.equal(await panel.getByText('Report is readable', { exact: true }).count(), 0)
  assert.equal(await panel.getByText(basis.claim, { exact: true }).count(), 0)
  assert.match(await panel.innerText(), /Title requires review/)
  await panel.getByTitle('Jump to this Harness state update').click()
  assert.match(await panel.innerText(), /File changed/)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: '/tmp/replay-hoh-state.png', fullPage: true })
  console.log('PASS HoH State: playhead, task items, evidence disclosure, invalidation and timestamp jump')
} finally {
  await browser.close()
}

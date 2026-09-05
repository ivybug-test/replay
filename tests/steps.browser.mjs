// Run against a built, running Replay. Only this browser's API requests are
// mocked; no test run or task is written to the backend or OSS.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.REPLAY_TEST_URL ?? 'http://127.0.0.1:18768'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const step = (id, ms, message) => ({
    step_id: id, source: 'agent', message,
    extra: { osworld_harness: { timing: { clock: 'episode_elapsed_ms', start_ms: ms, end_ms: ms + 100 } } },
  })
  const document = (id, role, steps, children = []) => ({
    schema_version: 'ATIF-v1.8', trajectory_id: id,
    agent: { name: 'omp', version: '1', extra: { osworld_harness: { agent_id: id, role } } },
    steps, subagent_trajectories: children,
  })
  const child = document('worker-id', 'gui_worker', [step(1, 200, 'Working'), step(2, 400, 'Done')])
  const first = {
    ...step(1, 100, 'Delegate'),
    tool_calls: [{ tool_call_id: 'dispatch-1', function_name: 'delegate', arguments: { task: 'Check desktop' } }],
    observation: { results: [{ source_call_id: 'dispatch-1', content: 'Complete', subagent_trajectory_ref: [{ trajectory_id: 'worker-id' }] }] },
  }
  const trajectory = document('main-id', 'main', [first, step(2, 300, 'Meanwhile'), step(3, 500, 'Finish')], [child])
  trajectory.extra = { osworld_harness: { schema_version: 'osworld-harness/v1', events: [
    { sequence: 10, episode_elapsed_ms: 200, event_type: 'tool_execution_end' },
    { sequence: 20, episode_elapsed_ms: 600, event_type: 'observer_interval', record: { record: {
      interval_id: 1, model_turns: 5, end_sequence: 10, status: 'completed', description: 'GUI 正在检查窗口。'
    } } },
    { sequence: 21, episode_elapsed_ms: 700, event_type: 'execution_state_goal', record: { statement: 'old goal' } },
    { sequence: 22, episode_elapsed_ms: 0, event_type: 'planner_state', record: {
      schema_version: 'planner-state/v1', cause: 'plan_updated', tool_call_id: 'plan-1',
      plan: { version: 1, completed: [], remaining: [
        { id: 'inspect', agent: 'stateact_gui', task: 'Check desktop', max_turns: 10 },
      ], next: { id: 'inspect', agent: 'stateact_gui', task: 'Check desktop', max_turns: 10 } },
      budget: { maxTurns: 200, usedTurns: 1, remainingTurns: 199 },
    } },
  ] } }
  let polls = 0
  await page.route('**/api/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const responses = {
      '/api/batch': { batch: { batch_id: 'ui-test', batch_name: 'Delegation test', status: 'running', configuration: { model: 'omp-qwen' }, tasks: [{ key: 'task', task_id: '003', status: 'running' }] } },
      '/api/trajectory': trajectory,
      '/api/window': { duration_ms: 1000, terminal: false, timeline: { agent: [], desktop: [] } },
      '/api/execution-state': { version: 'execution-state/v2', counts: { action: 1 }, duration_ms: 1000, terminal: false,
        events: [{ sequence: 1, episode_elapsed_ms: 200, event: 'execution_state_action', record: { id: 'action-1', status: 'completed' } }] },
    }
    if (pathname === '/api/trajectory') polls++
    await route.fulfill({ status: responses[pathname] ? 200 : 404, contentType: 'application/json', body: JSON.stringify(responses[pathname] ?? {}) })
  })
  await page.goto(`${base}/live/runs/ui-test/tasks/task`)
  const tree = page.getByRole('list', { name: 'Agent delegation tree' })
  await tree.waitFor()
  assert.equal(await page.locator('[data-agent-id="main-id"] [data-agent-id="worker-id"]').count(), 1)
  assert.equal(await tree.locator('[data-step-index]').count(), 5)
  await page.getByRole('button', { name: 'Collapse agent gui_worker', exact: true }).click()
  assert.equal(await tree.locator('[data-step-index]').count(), 3)
  const priorPolls = polls
  const deadline = Date.now() + 10000
  while (polls <= priorPolls) {
    assert.ok(Date.now() < deadline, 'live poll did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(await page.getByRole('button', { name: 'Expand agent gui_worker', exact: true }).count(), 1)
  console.log('PASS hierarchy and folding survive live refresh')

  // Polls for the same run ID must replace inline step content, not merely
  // refresh its metadata. This used to stay stale until a full page reload.
  trajectory.steps[1].message = 'Meanwhile live update'
  await page.waitForFunction(() => document.querySelector('[data-step-index="2"]')?.textContent?.includes('Meanwhile live update'))
  assert.equal(await page.getByRole('button', { name: 'Expand agent gui_worker', exact: true }).count(), 1)
  console.log('PASS same-run live text changes reach the Steps panel without resetting folds')

  await page.getByTitle('Next step', { exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-step-index="1"]')?.getAttribute('aria-current') === 'step')
  assert.equal(await page.getByRole('button', { name: 'Collapse agent gui_worker', exact: true }).count(), 1)
  console.log('PASS external step navigation reveals folded branch')

  await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
  assert.equal(await tree.locator('[data-step-index]').count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Expand agent main', exact: true }).count(), 1)
  const expandWorker = page.getByRole('button', { name: 'Expand agent gui_worker', exact: true })
  assert.ok(await expandWorker.isVisible(), 'Collapse all must preserve child agent headers')
  assert.ok(await page.locator('[data-agent-id="worker-id"] button[title="delegate"]').isVisible())
  await expandWorker.click()
  assert.deepEqual(await tree.locator('[data-step-index]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-step-index'))), ['1', '3'])
  assert.equal(await page.getByRole('button', { name: 'Expand agent main', exact: true }).count(), 1)
  await page.locator('[data-step-index="3"]').click()
  assert.equal(await page.getByRole('button', { name: 'Expand agent main', exact: true }).count(), 1, 'selecting a child step must not expand parent steps')
  await page.getByRole('button', { name: 'Expand agent main', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse agent main', exact: true }).click()
  assert.deepEqual(await tree.locator('[data-step-index]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-step-index'))), ['1', '3'])
  await page.getByRole('button', { name: 'Expand all', exact: true }).click()
  assert.equal(await tree.locator('[data-step-index]').count(), 5)
  await page.getByRole('button', { name: 'Chronological', exact: true }).click()
  assert.deepEqual(await page.locator('[data-tour="timeline"] [data-step-index]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-step-index'))), ['0', '1', '2', '3', '4'])
  await page.getByRole('button', { name: 'By agent', exact: true }).click()
  await page.locator('[data-agent-id="worker-id"] button[title="delegate"]').click()
  assert.equal(await page.locator('[data-step-index="0"]').getAttribute('aria-current'), 'step')
  console.log('PASS collapse all, chronological mode and parent jump')

  await page.getByRole('button', { name: 'Collapse agent gui_worker', exact: true }).click()
  await page.getByRole('button', { name: 'State (2)', exact: true }).click()
  const statePanel = page.getByRole('region', { name: 'Execution State', exact: true })
  await statePanel.getByText('GUI 正在检查窗口。', { exact: true }).waitFor()
  await statePanel.getByText('Plan v1', { exact: true }).waitFor()
  assert.equal(await statePanel.locator('[data-plan-node="inspect"][data-plan-status="next"]').count(), 1)
  assert.match(await statePanel.textContent(), /1 \/ 200 · 199 left/)
  assert.equal(await statePanel.getByRole('button', { name: /Goals|Actions|Checkpoints|Evidence|Recovery/ }).count(), 0)
  trajectory.extra.osworld_harness.events[1].record.record.description = 'GUI 已确认窗口内容。'
  await statePanel.getByText('GUI 已确认窗口内容。', { exact: true }).waitFor()
  await page.getByTitle('Move Desktop and Steps to this event').click()
  await page.waitForFunction(() => document.querySelector('[data-step-index="1"]')?.getAttribute('aria-current') === 'step')
  assert.equal(await page.getByRole('button', { name: 'Collapse agent gui_worker', exact: true }).count(), 1)
  await page.getByRole('button', { name: 'Step', exact: true }).click()
  console.log('PASS State event jump reveals the delegated agent')

  await page.locator('[data-tour="timeline"]').getByRole('button', { name: 'Hide steps panel', exact: true }).click()
  assert.equal(await page.locator('#trajectory-steps').evaluate((el) => el.getBoundingClientRect().width), 0)
  assert.equal(await page.getByRole('button', { name: 'Show steps panel', exact: true }).getAttribute('aria-expanded'), 'false')
  await page.getByRole('button', { name: 'Show steps panel', exact: true }).click()
  assert.ok(await page.locator('#trajectory-steps').evaluate((el) => el.getBoundingClientRect().width) > 100)
  await page.setViewportSize({ width: 1280, height: 800 })
  assert.ok(await page.locator('#trajectory-steps').evaluate((el) => el.getBoundingClientRect().width) > 100)
  if (process.env.REPLAY_TEST_SCREENSHOT) await page.screenshot({ path: process.env.REPLAY_TEST_SCREENSHOT })
  console.log('PASS sidebar hide/show and narrow desktop layout')

  // A long trajectory previously scrolled Expand/Collapse all offscreen when
  // seeking reopened a branch. Exercise the actual transport range control.
  trajectory.steps.push(...Array.from({ length: 80 }, (_, index) => step(index + 4, 600 + index * 100, `Long step ${index + 4}`)))
  await page.locator('[data-step-index="84"]').waitFor({ state: 'attached' })
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
  const toolbarBefore = await page.locator('[data-steps-toolbar]').boundingBox()
  const pageScrollBefore = await page.locator('main').evaluate((el) => el.scrollTop)
  const slider = page.locator('[data-tour="transport"] input[type="range"]')
  await slider.focus()
  await slider.press('End')
  await page.waitForFunction(() => {
    const list = document.querySelector('[data-steps-scroll]')
    const selected = document.querySelector('[data-step-index="84"][aria-current="step"]')
    return list?.scrollTop > 0 && !!selected
  })
  const toolbarAfter = await page.locator('[data-steps-toolbar]').boundingBox()
  assert.deepEqual(toolbarAfter, toolbarBefore, 'seeking must not move the toolbar')
  assert.equal(await page.locator('main').evaluate((el) => el.scrollTop), pageScrollBefore)
  for (const name of ['Expand all', 'Collapse all']) {
    const bounds = await page.getByRole('button', { name, exact: true }).boundingBox()
    assert.ok(bounds && bounds.y >= toolbarAfter.y && bounds.y + bounds.height <= toolbarAfter.y + toolbarAfter.height)
  }
  const listBounds = await page.locator('[data-steps-scroll]').boundingBox()
  const activeBounds = await page.locator('[data-step-index="84"]').boundingBox()
  assert.ok(activeBounds.y >= listBounds.y - 1 && activeBounds.y + activeBounds.height <= listBounds.y + listBounds.height + 1)
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
  assert.equal(await tree.locator('[data-step-index]').count(), 0)
  console.log('PASS long-trajectory seeking keeps toolbar visible and only scrolls steps')

  child.subagent_trajectories.push(document('nested-id', 'nested_worker', [step(1, 450, 'Nested work')]))
  await page.locator('[data-agent-id="worker-id"] [data-agent-id="nested-id"]').waitFor()
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
  assert.equal(await tree.locator('[data-step-index]').count(), 0)
  for (const name of ['main', 'gui_worker', 'nested_worker']) {
    assert.ok(await page.getByRole('button', { name: `Expand agent ${name}`, exact: true }).isVisible())
  }
  await page.getByRole('button', { name: 'Expand agent nested_worker', exact: true }).click()
  assert.equal(await tree.locator('[data-step-index]').count(), 1)
  assert.ok(await tree.locator('[data-step-index]').textContent().then(text => text.includes('Nested work')))
  console.log('PASS collapsed ancestors preserve nested delegation and independent step expansion')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}

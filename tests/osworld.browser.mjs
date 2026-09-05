// Checks the actual imported catalog and its integration with the built app.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.REPLAY_TEST_URL ?? 'http://127.0.0.1:18768'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const response = await page.request.get(`${base}/osworld-v2.dataset.json`)
  assert.equal(response.status(), 200)
  const catalog = await response.json()
  const expectedIds = catalog.tasks.map((task) => task.id).sort()
  assert.equal(new Set(expectedIds).size, expectedIds.length)
  assert.ok(expectedIds.length > 0)
  const original = await (await page.request.get(`${base}/dataset.json`)).json()
  await page.goto(`${base}/tasks`)
  const links = page.locator('a[href^="/tasks/osworld-v2-"]')
  await links.first().waitFor()
  assert.deepEqual(await links.evaluateAll((items) => items.map((item) => item.getAttribute('href').split('/').pop()).sort()), expectedIds)
  assert.ok(await page.locator(`a[href="/tasks/${original.tasks[0].id}"]`).count(), 'Original tasks remain available')
  console.log(`PASS all ${expectedIds.length} imported tasks and original tasks appear together`)

  const assertVisible = async (ids) => {
    const sorted = [...ids].sort()
    await page.waitForFunction((expected) => {
      const actual = [...document.querySelectorAll('a[href^="/tasks/osworld-v2-"]')]
        .map((item) => item.getAttribute('href').split('/').pop()).sort()
      return JSON.stringify(actual) === JSON.stringify(expected)
    }, sorted)
  }
  const capabilities = [...new Set(catalog.tasks.flatMap((task) => task.metadata.capabilities))]
  const label = (capability) => ({
    cross_source_reasoning: 'Cross-source reasoning',
    multi_item_state_tracking: 'Multi-item state tracking',
    visual_spatial_precision: 'Visual-spatial precision',
  }[capability] ?? capability[0].toUpperCase() + capability.slice(1).replaceAll('_', ' '))
  for (const capability of capabilities) {
    const expected = catalog.tasks.filter((task) => task.metadata.capabilities.includes(capability))
    const button = page.getByRole('button', { name: `${label(capability)} · ${expected.length}`, exact: true })
    assert.equal(await button.count(), 1)
    await button.click()
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    await assertVisible(expected.map((task) => task.id))
    await button.click()
  }
  const firstCapabilities = ['cross_source_reasoning', 'tutorial_following']
  for (const capability of firstCapabilities) {
    await page.getByRole('button', { name: new RegExp(`^${label(capability)} ·`) }).click()
  }
  const union = catalog.tasks.filter((task) => firstCapabilities.some((capability) => task.metadata.capabilities.includes(capability)))
  await assertVisible(union.map((task) => task.id))
  await page.getByLabel('Difficulty', { exact: true }).selectOption('hard')
  await assertVisible(union.filter((task) => task.difficulty === 'hard').map((task) => task.id))
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await assertVisible(expectedIds)
  const empty = capabilities.flatMap((capability) => ['easy', 'medium', 'hard'].map((difficulty) => ({ capability, difficulty })))
    .find(({ capability, difficulty }) => !catalog.tasks.some((task) => task.difficulty === difficulty && task.metadata.capabilities.includes(capability)))
  if (empty) {
    await page.getByRole('button', { name: new RegExp(`^${label(empty.capability)} ·`) }).click()
    await page.getByLabel('Difficulty', { exact: true }).selectOption(empty.difficulty)
    await assertVisible([])
    assert.equal(await page.getByText('No tasks match these filters.', { exact: true }).count(), 1)
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await assertVisible(expectedIds)
  }
  assert.ok(await page.locator(`a[href="/tasks/${original.tasks[0].id}"]`).count())
  console.log('PASS all capability counts, multi-label union, difficulty intersection, empty results and clearing')

  await page.goto(`${base}/tasks/${catalog.tasks[0].id}`)
  await page.locator('[data-tour="task-files"]').waitFor()
  assert.equal(await page.getByRole('heading', { name: catalog.tasks[0].title, exact: true }).count(), 1)
  assert.ok((await page.locator('[data-tour="task-files"]').innerText()).includes('instruction.md'))
  assert.equal(await page.getByRole('heading', { name: 'Agent runs (0)', exact: true }).count(), 1)
  assert.equal(await page.getByText('This task contains runtime values.', { exact: false }).count(), 0)
  for (const capability of catalog.tasks[0].metadata.capabilities) {
    assert.ok(await page.getByText(label(capability), { exact: true }).count())
  }
  assert.equal(await page.getByRole('link', { name: 'knowledge base', exact: true }).getAttribute('href'), catalog.tasks[0].metadata.difficulty_source)
  await page.reload()
  await page.getByRole('heading', { name: catalog.tasks[0].title, exact: true }).waitFor()
  console.log('PASS task details and reload work without browser uploads')

  const template = catalog.tasks.find((task) => task.instruction.includes('{{HOST_SUFFIX}}'))
  assert.ok(template)
  await page.goto(`${base}/tasks/${template.id}`)
  await page.locator('[data-tour="task-files"]').waitFor()
  assert.ok((await page.locator('[data-tour="task-files"]').innerText()).includes('{{HOST_SUFFIX}}'))
  assert.equal(await page.getByText('This task contains runtime values.', { exact: false }).count(), 1)
  assert.deepEqual(errors, [])
  console.log('PASS runtime instruction placeholders are visible and explained; no browser errors')
} finally {
  await browser.close()
}

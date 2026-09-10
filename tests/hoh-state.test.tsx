import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { hohEvents, type HohState } from '../src/lib/hohState'
import type { AtifTrajectory } from '../src/lib/atif'
import ExecutionStatePanel from '../src/components/ExecutionStatePanel'

const artifact = { id: 'a1', description: 'Report', requirements: ['Readable report'], file_path: '/tmp/report.txt' }
const item = { target: { artifact_ids: ['a1', 'a2'], description: 'Save the complete report' }, preserve: ['Title'], gate: ['Report readable'] }
const verified = { id: 'v1', artifact_ids: ['a1'], claim: 'Report is readable', reason: 'Checked contents',
  evidence: [{ ref: 'verifier:read1', observation: 'Read the saved report' }] }
const gap = { id: 'g1', artifact_ids: ['a1'], claim: 'Title requires review', reason: 'Not checked', evidence: [] }
const event = (sequence: number, agent: string, hoh: Record<string, unknown>, status = 'completed') => ({
  event_type: 'subagent_lifecycle', sequence, episode_elapsed_ms: sequence * 100,
  record: { agent, status, hoh },
})
const trajectory = (events: unknown[]) => ({ schema_version: 'ATIF-v1.8', trajectory_id: 'root',
  agent: { name: 'hoh', version: '1' }, steps: [], extra: { osworld_harness: { events } },
}) as AtifTrajectory
const history = [
  event(1, 'hoh_planner', { loop: 1, state_revision: 1, planner_output: { artifacts: [artifact], task_items: [item] } }),
  event(2, 'hoh_verifier', { loop: 1, state_revision: 2, verification: { verified: [verified], gaps: [gap] } }),
  event(3, 'hoh_planner', { loop: 2, state_revision: 2, planner_output: { task_items: [{ ...item, target: 'a1: revise title' }] } }),
  event(4, 'hoh_executor', { loop: 2, state_revision: 3, invalidated_verified: ['v1'],
    artifact_changes: [{ artifact_id: 'a1', reason: 'file_changed' }] }, 'failed'),
  event(5, 'hoh_verifier', { loop: 2, state_revision: 4, verification: { verified: [{ ...verified, id: 'v2' }], gaps: [] } }),
]

test('HoH state folds committed stages, preserves artifacts and applies failed Executor invalidation without creating gaps', () => {
  const events = hohEvents(trajectory([...history].reverse()))
  assert.equal(events.length, 5)
  const states = events.map(e => e.record as unknown as HohState)
  assert.deepEqual(states[0].verified, [])
  assert.deepEqual(states[2].artifacts, [artifact])
  assert.equal(states[2].task_items?.[0].target, 'a1: revise title')
  assert.deepEqual(states[3].verified, [])
  assert.deepEqual(states[3].gaps, [gap])
  assert.deepEqual(states[1].verified, [verified], 'later deletion must not mutate historical snapshots')
  assert.deepEqual(states[4].gaps, [])
  assert.deepEqual(states[4].invalidated_verified, [])
  assert.equal(states[4].verified?.[0].id, 'v2')
  const finished = hohEvents(trajectory([...history.slice(0, 4), event(5, 'hoh_planner', {
    loop: 3, state_revision: 3, planner_output: { done: true, task_items: [] },
  })]))
  const state = finished[4].record as unknown as HohState
  assert.equal(state.done, true)
  assert.deepEqual(state.gaps, [gap], 'Planner completion does not erase gaps')
  const html = renderToStaticMarkup(<ExecutionStatePanel
    feed={{ version: 'harness-state/v1', counts: {}, events: finished, terminal: true, duration_ms: 500 }}
    playheadMs={500} onJump={() => {}} />)
  assert.match(html, /Planner declared the task complete/)
  assert.match(html, /Title requires review/)
  const candidate = { id: 'b1', kind: 'basis', artifact_ids: ['a1'], claim: 'The format supports headings',
    reason: 'Needed to format the report', source_files: ['/tmp/format.md'],
    evidence: [{ ref: 'executor:read2', observation: 'Format documentation' }] }
  const confirmed = { ...candidate, evidence: [{ ref: 'verifier:read2', observation: 'Headings are supported' }] }
  const claimEvents = hohEvents(trajectory([
    ...history.slice(0, 2),
    event(3, 'hoh_executor', { loop: 2, claims: [candidate] }),
    event(4, 'hoh_verifier', { loop: 2, claims: [], verification: { verified: [verified, confirmed], gaps: [gap] } }),
    event(5, 'hoh_executor', { loop: 3, claims: [{ ...candidate, source_files: [] }], invalidated_verified: ['b1'] }, 'failed'),
  ]))
  assert.equal(claimEvents.length, 5, 'claim-only lifecycle updates must be folded')
  assert.deepEqual((claimEvents[2].record as unknown as HohState).claims, [candidate])
  assert.deepEqual((claimEvents[3].record as unknown as HohState).claims, [])
  assert.deepEqual((claimEvents[4].record as unknown as HohState).verified, [verified])
  const renderClaims = (at: number) => renderToStaticMarkup(<ExecutionStatePanel
    feed={{ version: 'harness-state/v1', counts: {}, events: claimEvents, terminal: false, duration_ms: 600 }}
    playheadMs={at} onJump={() => {}} />)
  assert.doesNotMatch(renderClaims(250), /Candidate claims/, 'historical runs do not invent candidates')
  const pending = renderClaims(350)
  for (const text of ['Unverified', 'Execution basis', '/tmp/format.md', 'executor:read2']) assert.ok(pending.includes(text), text)
  const section = (html: string, title: string) => html.match(new RegExp(`<section aria-label="${title}"[\\s\\S]*?<\\/section>`))?.[0] ?? ''
  assert.doesNotMatch(section(pending, 'Verified'), /The format supports headings/)
  const reviewed = renderClaims(450)
  assert.match(section(reviewed, 'Verified'), /Headings are supported/)
  assert.match(section(reviewed, 'Verified'), /Delivery requirement/)
  assert.doesNotMatch(section(reviewed, 'Candidate claims'), /The format supports headings/)
  assert.match(renderClaims(550), /Dynamic source/)
  assert.match(renderClaims(550), /Removed: b1/, 'basis invalidation is visible without artifact changes')
  assert.deepEqual((claimEvents[2].record as unknown as HohState).claims, [candidate], 'later snapshots do not mutate history')


})

test('State panel respects playhead, renders claim bindings and evidence, and removes expired verified', () => {
  const events = hohEvents(trajectory(history))
  const render = (at: number) => renderToStaticMarkup(<ExecutionStatePanel
    feed={{ version: 'harness-state/v1', counts: {}, events, terminal: false, duration_ms: 500 }}
    playheadMs={at} onJump={() => {}} />)
  assert.doesNotMatch(render(50), /Report is readable|save report/)
  const before = render(250)
  for (const text of ['Task items', 'Save the complete report', 'Title', 'Report readable', 'Report is readable', 'verifier:read1', 'Title requires review']) {
    assert.ok(before.includes(text), text)
  }
  assert.match(before, /aria-label="Target artifacts"[^>]*><span[^>]*>a1<\/span><span[^>]*>a2<\/span>/)
  const after = render(450)
  assert.match(after, /a1: revise title/, 'historical string targets remain readable')
  assert.doesNotMatch(after, /aria-label="Target artifacts"/, 'legacy strings do not invent bindings')
  assert.doesNotMatch(after, /Report is readable|verifier:read1/)
  assert.match(after, /Title requires review/)
  assert.match(after, /Removed: v1/)
  assert.match(after, /File changed/)
  assert.doesNotMatch(after, /v2/)
})

test('Uncommitted model payloads are ignored and old Planner collections remain visible without invented artifacts', () => {
  const events = hohEvents(trajectory([
    { event_type: 'tool_execution_end', sequence: 1, episode_elapsed_ms: 0, record: { hoh: history[0].record.hoh } },
    event(2, 'hoh_planner', { loop: 1 }, 'failed'),
    event(3, 'hoh_planner', { loop: 1, planner_output: { task_items: [item], verified: [verified], gaps: [gap] } }),
  ]))
  assert.equal(events.length, 1)
  assert.equal(events[0].record?.artifacts, undefined)
  assert.deepEqual(events[0].record?.verified, [verified])
})

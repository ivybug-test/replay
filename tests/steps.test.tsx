import { observerEvents, plannerEvents } from '../src/lib/observerFeed'
import ExecutionStatePanel from '../src/components/ExecutionStatePanel'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { atifTrajectoryToSteps } from '../src/lib/atifToViewer'
import { atifLiveToTrajectory } from '../src/lib/atifLive'
import { legacyTraceToAtif } from '../src/lib/legacyTraceToAtif'
import { buildStepTree } from '../src/lib/stepTree'
import StepTimeline from '../src/components/StepTimeline'
import type { AtifTrajectory, AtifStep } from '../src/lib/atif'
import type { Step } from '../src/lib/types'
import { formatJsonForDisplay } from '../src/lib/format'

const step = (id: number, ms: number, message: string): AtifStep => ({
  step_id: id, source: 'agent', message,
  extra: { osworld_harness: { timing: { start_ms: ms, end_ms: ms + 100 } } },
})
const document = (id: string, role: string, steps: AtifStep[], children: AtifTrajectory[] = []): AtifTrajectory => ({
  schema_version: 'ATIF-v1.8', trajectory_id: id,
  agent: { name: 'omp', version: '1', extra: { osworld_harness: { agent_id: id, role } } },
  steps, subagent_trajectories: children,
})

test('JSON display can expand nested serialized tool results without altering ordinary strings', () => {
  const input = JSON.stringify({
    result: JSON.stringify({ data: { status: 'completed', evidence: ['folder contains files'] } }),
    command: 'echo \'{"status":"completed"}\'',
  })
  assert.equal(formatJsonForDisplay(input, true), `{
  "result": {
    "data": {
      "status": "completed",
      "evidence": [
        "folder contains files"
      ]
    }
  },
  "command": "echo '{\\"status\\":\\"completed\\"}'"
}`)
})

function fixture() {
  const child = document('worker-id', 'gui_worker', [step(1, 200, 'Working'), step(2, 400, 'Done')])
  const delegate = { ...step(1, 100, 'Delegate'),
    tool_calls: [{ tool_call_id: 'dispatch-1', function_name: 'delegate', arguments: {} }],
    observation: { results: [{ source_call_id: 'dispatch-1', content: 'Complete', subagent_trajectory_ref: [{ trajectory_id: 'worker-id' }] }] },
  }
  return document('main-id', 'main', [delegate, step(2, 300, 'Meanwhile'), step(3, 500, 'Finish')], [child])
}

test('ATIF keeps agent identity, parent and delegation call without changing chronological indexes', () => {
  const steps = atifTrajectoryToSteps(fixture())
  assert.deepEqual(steps.map(s => s.text), ['Delegate', 'Working', 'Meanwhile', 'Done', 'Finish'])
  assert.deepEqual(steps.map(s => s.index), [0, 1, 2, 3, 4])
  assert.equal(steps[1].agent?.label, 'gui_worker')
  assert.equal(steps[1].agent?.parentId, 'main-id')
  assert.equal(steps[1].agent?.parentLabel, 'main')
  assert.equal(steps[1].agent?.delegationStepIndex, 0)
  assert.equal(steps[1].agent?.delegationTool, 'delegate')
  assert.equal(steps[1].sourceStepId, 1)
  assert.equal(steps[1].role, 'agent')
})

test('tree groups agents and keeps original step references', () => {
  const steps = atifTrajectoryToSteps(fixture())
  const roots = buildStepTree(steps)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].totalSteps, 5)
  assert.deepEqual(roots[0].steps.map(s => s.index), [0, 2, 4])
  assert.equal(roots[0].children[0].agent.id, 'worker-id')
  assert.equal(roots[0].children[0].steps[0], steps[1])
})

test('nested agents with the same role remain distinct and missing call links do not invent a step', () => {
  const inner = document('nested', 'worker', [step(1, 300, 'Nested')])
  const outer = document('outer', 'worker', [step(1, 200, 'Outer')], [inner])
  const input = document('main', 'main', [step(1, 100, 'Main')], [outer])
  const steps = atifTrajectoryToSteps(input)
  const tree = buildStepTree(steps)
  assert.equal(tree[0].children[0].children[0].agent.id, 'nested')
  assert.equal(steps[1].agent?.delegationStepIndex, undefined)
})

test('legacy model inputs and messages share their real role, without guessed parent edges', () => {
  const work = { terminal: true, duration_ms: 1000, agents: [], items: [{
    id: 'work-1', agent_id: 'worker', label: 'GUI', role: 'gui_worker', origin: 'computer',
    start_ms: 100, thinking_ms: 0, ongoing: false, global_turn_num: 7, tools: [], details: [],
    model_inputs: [{ request_index: 1, new_images: [{ path: 'image.png', sha256: 'image' }] }],
    message: { role: 'assistant' as const, blocks: [{ type: 'text', text: 'Done' }] },
  }] }
  const input = legacyTraceToAtif(work, { sessionId: 's', trajectoryId: 'root', agentName: 'legacy', imageUrl: () => 'https://example.test/image.png' })
  const steps = atifTrajectoryToSteps(input)
  assert.equal(steps.length, 2)
  assert.deepEqual(steps.map(s => s.agent?.id), ['worker', 'worker'])
  assert.deepEqual(steps.map(s => s.agent?.role), ['gui_worker', 'gui_worker'])
  assert.equal(steps[1].turn, 7)
  assert.equal(steps[1].agent?.parentId, undefined)
})

test('live lifecycle becomes the same delegation tree as an archive', () => {
  const root = fixture()
  const patch = (value: Record<string, unknown>) => ({ trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1', ...value })
  const records = [
    patch({ trajectory_id: 'main-id', op: 'append_step', step: { ...root.steps[0], observation: undefined } }),
    patch({ trajectory_id: 'worker-id', op: 'append_step', step: root.subagent_trajectories![0].steps[0] }),
    patch({ op: 'append_harness_event', event: { event_type: 'subagent_lifecycle', record: { id: 'worker-id', parentAgentId: 'main-id', parentToolCallId: 'dispatch-1', agent: 'gui_worker' } } }),
  ]
  const trajectory = atifLiveToTrajectory({ trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1', start_line: 0, total_lines: 3, terminal: false, records })
  assert.ok(trajectory)
  const steps = atifTrajectoryToSteps(trajectory)
  assert.equal(steps[1].agent?.parentId, 'main-id')
  assert.equal(steps[1].agent?.label, 'gui_worker')
  assert.equal(steps[1].agent?.delegationStepIndex, 0)
})

test('unattributed old datasets remain navigable; orphan/cyclic parents cannot hide steps', () => {
  const steps: Step[] = [
    { index: 0, role: 'user' },
    { index: 1, role: 'agent', agent: { id: 'a', label: 'a', parentId: 'b' } },
    { index: 2, role: 'agent', agent: { id: 'b', label: 'b', parentId: 'a' } },
    { index: 3, role: 'agent', agent: { id: 'c', label: 'c', parentId: 'missing' } },
  ]
  const roots = buildStepTree(steps)
  assert.equal(roots.length, 4)
  assert.equal(roots.reduce((n, group) => n + group.totalSteps, 0), 4)
})

test('rendered tree exposes collapsible branches, attribution and delegation navigation', () => {
  const html = renderToStaticMarkup(<StepTimeline steps={atifTrajectoryToSteps(fixture())} activeStep={1} labels={[]} aftSteps={new Set([1])} onSelect={() => {}} onCollapse={() => {}} />)
  assert.match(html, /Agent delegation tree/)
  assert.match(html, /Collapse agent gui_worker/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /from main/)
  assert.match(html, /Chronological/)
  assert.match(html, /aria-current="step"/)
  assert.match(html, /Collapse all/)
})

test('Observer history and snapshot produce one report per interval and omit old execution metrics', () => {
  const trajectory = fixture()
  const report = { interval_id: 1, start_sequence: 4, end_sequence: 10, model_turns: 5, status: 'completed', description: '正在检查窗口。' }
  trajectory.extra = { osworld_harness: { events: [
    { sequence: 10, episode_elapsed_ms: 200, event_type: 'tool_execution_end' },
    { sequence: 20, episode_elapsed_ms: 600, event_type: 'observer_interval', record: { record: report } },
    { sequence: 21, episode_elapsed_ms: 700, event_type: 'execution_state_goal', record: { statement: 'old goal' } },
    { sequence: 30, episode_elapsed_ms: 800, event_type: 'observer_interval', record: { record: { interval_id: 2, status: 'failed', model_turns: 5, error: 'timeout' } } },
  ], state: { observer: report } } }
  const events = observerEvents(trajectory)
  assert.equal(events.length, 2)
  assert.equal(events[0].episode_elapsed_ms, 200, 'jump to observed interval rather than delayed report arrival')
  const html = renderToStaticMarkup(<ExecutionStatePanel feed={{ version: 'observer', counts: {}, events, terminal: false, duration_ms: 800 }} playheadMs={200} onJump={() => {}} />)
  assert.match(html, /正在检查窗口/)
  assert.match(html, /Observer unavailable: timeout/)
  assert.doesNotMatch(html, /old goal|Checkpoints|Goals|Actions|Evidence|Raw event/)
  trajectory.extra.osworld_harness.events = []
  assert.equal(observerEvents(trajectory)[0].record?.description, report.description)
})

test('Planner history follows the playhead and renders node outcomes and budget', () => {
  const trajectory = fixture()
  const inspect = { id: 'inspect', agent: 'stateact_browser', task: 'Inspect the page', max_turns: 10 }
  const edit = { id: 'edit', agent: 'stateact_gui', task: 'Apply the change', max_turns: 20 }
  const first = {
    schema_version: 'planner-state/v1', cause: 'plan_updated', tool_call_id: 'plan-1',
    plan: { version: 1, completed: [], remaining: [inspect, edit], next: inspect },
    budget: { maxTurns: 200, usedTurns: 1, remainingTurns: 199 },
  }
  const second = {
    schema_version: 'planner-state/v1', cause: 'executor_returned', tool_call_id: 'task-1',
    plan: { version: 1, completed: [{ ...inspect, outcome: 'completed' }], remaining: [edit], next: edit },
    budget: { maxTurns: 200, usedTurns: 12, remainingTurns: 188 },
  }
  trajectory.extra = { osworld_harness: { events: [
    { sequence: 4, episode_elapsed_ms: 100, event_type: 'planner_state', record: first },
    { sequence: 9, episode_elapsed_ms: 500, event_type: 'planner_state', record: second },
  ], state: { planner: second } } }
  const events = plannerEvents(trajectory)
  assert.equal(events.length, 2, 'latest state must not duplicate its history event')
  const early = renderToStaticMarkup(<ExecutionStatePanel feed={{ version: 'harness-state/v1', counts: { planner: 2 }, events, terminal: false, duration_ms: 600 }} playheadMs={200} onJump={() => {}} />)
  assert.match(early, /Plan v1/)
  assert.match(early, /1 \/ 200 · 199 left/)
  assert.match(early, /data-plan-node="inspect" data-plan-status="next"/)
  assert.match(early, /data-plan-node="edit" data-plan-status="pending"/)
  const late = renderToStaticMarkup(<ExecutionStatePanel feed={{ version: 'harness-state/v1', counts: { planner: 2 }, events, terminal: false, duration_ms: 600 }} playheadMs={600} onJump={() => {}} />)
  assert.match(late, /1\/2 nodes finished/)
  assert.match(late, /data-plan-node="inspect" data-plan-status="completed"/)
  assert.match(late, /data-plan-node="edit" data-plan-status="next"/)
})

test('live Observer patches project to the same panel feed and empty old runs show no metrics', () => {
  const patch = (value: Record<string, unknown>) => ({ trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1', ...value })
  const trajectory = atifLiveToTrajectory({ trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1', start_line: 0, total_lines: 2, terminal: false, records: [
    patch({ trajectory_id: 'main', op: 'append_step', step: step(1, 100, 'Inspect') }),
    patch({ op: 'append_harness_event', event: { sequence: 20, episode_elapsed_ms: 600, event_type: 'observer_interval', record: { record: { interval_id: 1, model_turns: 5, status: 'completed', description: '已找到窗口。' } } } }),
  ] })!
  assert.equal(observerEvents(trajectory)[0].record?.description, '已找到窗口。')
  const html = renderToStaticMarkup(<ExecutionStatePanel feed={{ version: 'old', counts: { goal: 1 }, events: [{ event: 'execution_state_goal', sequence: 1, episode_elapsed_ms: 0, record: { statement: 'legacy goal' } }], terminal: true, duration_ms: 0 }} playheadMs={0} onJump={() => {}} />)
  assert.match(html, /No Planner or Observer state recorded/)
  assert.doesNotMatch(html, /legacy goal|Goals/)
})

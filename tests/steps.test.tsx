import './hoh-state.test'
import { observerEvents, plannerEvents } from '../src/lib/observerFeed'
import ExecutionStatePanel from '../src/components/ExecutionStatePanel'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { atifTrajectoryToSteps } from '../src/lib/atifToViewer'
import { atifLiveToTrajectory, mergeAtifLiveSnapshot } from '../src/lib/atifLive'
import { buildStepTree } from '../src/lib/stepTree'
import StepTimeline, { formatContextSize } from '../src/components/StepTimeline'
import type { AtifTrajectory, AtifStep } from '../src/lib/atif'
import type { Step } from '../src/lib/types'
import { formatJsonForDisplay, formatObservationForDisplay } from '../src/lib/format'
import Markdown from '../src/components/Markdown'
import { stepIndexForTurn } from '../src/lib/stepNavigation'
import { uniqueSortedTurnEvidence } from '../src/lib/analysisEvidence'
import { isActiveJob, isStaleReport, isTerminalJob, jobPhaseLabel } from '../src/lib/analysisJobs'
import type { ExecutionStateFeed } from '../src/lib/ossReplay'

const step = (id: number, ms: number, message: string): AtifStep => ({
  step_id: id, source: 'agent', message,
  extra: { osworld_harness: { timing: { start_ms: ms, end_ms: ms + 100 } } },
})
const document = (id: string, role: string, steps: AtifStep[], children: AtifTrajectory[] = []): AtifTrajectory => ({
  schema_version: 'ATIF-v1.8', trajectory_id: id,
  agent: { name: 'omp', version: '1', extra: { osworld_harness: { agent_id: id, role } } },
  steps, subagent_trajectories: children,
})

test('live snapshots compact upserts without confusing source cursor with retained records', () => {
  const envelope = (op: string, extra: Record<string, unknown>) => ({
    trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
    trajectory_id: 'root', op, ...extra,
  })
  const first = mergeAtifLiveSnapshot(undefined, {
    trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
    start_line: 0, total_lines: 4, terminal: false, has_more: true,
    records: [
      envelope('upsert_step', { step: step(1, 0, 'old') }),
      envelope('tool_execution_update', { step_id: 1, progress: { content: 'noise' } }),
      envelope('upsert_step', { step: step(1, 0, 'new') }),
    ],
  })
  assert.equal(first.cursor, 3)
  assert.equal(first.stream.records.length, 1)
  assert.equal((first.stream.records[0].step as AtifStep).message, 'new')

  const second = mergeAtifLiveSnapshot(first, {
    trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
    start_line: 3, total_lines: 4, terminal: false, has_more: false,
    records: [envelope('append_desktop_frame', { frame: { frame_index: 1 } })],
  })
  assert.equal(second.cursor, 4)
  assert.equal(second.stream.records.length, 2)
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

test('delegated observations restore serialized output line breaks', () => {
  const input = '<task-result id="worker">\n<output>\n"## Findings\\n\\nfirst line\\nsecond line"\n</output>\n</task-result>'
  assert.equal(
    formatObservationForDisplay(input),
    '<task-result id="worker">\n<output>\n## Findings\n\nfirst line\nsecond line\n</output>\n</task-result>',
  )
  assert.equal(formatObservationForDisplay('<output>\nnot-json\n</output>'), '<output>\nnot-json\n</output>')
})

test('markdown can preserve soft line breaks for observation output', () => {
  const html = renderToStaticMarkup(<Markdown content={'first line\nsecond line'} preserveLineBreaks />)
  assert.match(html, /whitespace-pre-wrap/)
  assert.match(html, /first line\nsecond line/)
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

test('harness provenance and message images reach native ATIF viewer steps', () => {
  const harnessStep = (
    id: number, source: 'user' | 'agent', message: unknown, provenance: Record<string, unknown>,
  ) => ({
    step_id: id, source, message,
    extra: { osworld_harness: { provenance, timing: { start_ms: id * 1000, end_ms: id * 1000 + 100 } } },
  })
  const trajectory = {
    schema_version: 'ATIF-v1.8', trajectory_id: 'root', session_id: 's',
    agent: { name: 'omp', version: '1' },
    steps: [
      harnessStep(1, 'user', [{ type: 'image', source: { path: 'shots/1.png', media_type: 'image/png' } }],
        { agent_id: 'worker', role: 'gui_worker' }),
      harnessStep(2, 'agent', 'Done', { agent_id: 'worker', role: 'gui_worker', global_turn_num: 7 }),
    ],
  }
  const steps = atifTrajectoryToSteps(trajectory, {
    resolveImage: (source) => `https://example.test/${source.path}`,
  })
  assert.equal(steps.length, 2)
  // The producing agent is identified by its harness provenance, and a flat
  // document must not invent a delegation edge between adjacent steps.
  assert.deepEqual(steps.map(s => s.agent?.id), ['worker', 'worker'])
  assert.deepEqual(steps.map(s => s.agent?.role), ['gui_worker', 'gui_worker'])
  assert.equal(steps[1].agent?.parentId, undefined)
  assert.equal(steps[1].turn, 7)
  // An image in the message becomes an input attachment on that step.
  assert.equal(steps[0].images?.[0]?.url, 'https://example.test/shots/1.png')
  assert.equal(steps[0].images?.[0]?.kind, 'input')
  assert.equal(steps[0].images?.[0]?.mimeType, 'image/png')
})

test('analysis Turn links resolve to the matching Agent step before timestamp fallback', () => {
  const steps: Step[] = [
    { index: 0, role: 'system' },
    { index: 1, role: 'agent' },
    { index: 2, role: 'tool' },
    { index: 3, role: 'agent' },
    { index: 4, role: 'user' },
    { index: 5, role: 'agent', turn: 7 },
  ]
  assert.equal(stepIndexForTurn(steps, 2), 3)
  assert.equal(stepIndexForTurn(steps, 7), 5)
  assert.equal(stepIndexForTurn(steps, 8), null)
})

test('analysis evidence links are deduplicated and sorted by global Turn', () => {
  const turns = [28, 29, 30, 31].map((global_turn) => ({
    global_turn, turn_id: `agent:${global_turn}`,
  }))
  const evidence = [31, 31, 29, 30, 31, 28].map((turn, index) => ({
    turn_id: `agent:${turn}`, timestamp_ms: index,
  }))
  const result = uniqueSortedTurnEvidence(evidence, turns)
  assert.deepEqual(result.map((item) => item.globalTurn), [28, 29, 30, 31])
  assert.equal(result.length, 4)
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

test('live scheduler ancestors retain sibling stages across incremental compacted polls', () => {
  const patch = (value: Record<string, unknown>) => ({ trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1', ...value })
  let snapshot: ReturnType<typeof mergeAtifLiveSnapshot> | undefined
  for (const [index, role] of ['planner', 'executor', 'verifier'].entries()) {
    const records = [
      patch({ op: 'append_harness_event', event: { event_type: 'subagent_lifecycle', record: {
        id: role, agent: role, parentAgentId: 'scheduler', parentRole: 'orchestrator',
      } } }),
      patch({ trajectory_id: role, op: 'upsert_step', step: {
        ...step(1, index * 100, role),
        extra: { osworld_harness: { timing: { start_ms: index * 100 }, provenance: { role } } },
      } }),
    ]
    snapshot = mergeAtifLiveSnapshot(snapshot, {
      trace_format: 'atif-stream', stream_schema_version: 'osworld-atif-stream/v1',
      start_line: index * 2, total_lines: (index + 1) * 2, terminal: false, records,
    })
    const trajectory = atifLiveToTrajectory(snapshot.stream)!
    assert.equal(trajectory.trajectory_id, 'scheduler')
    assert.deepEqual(trajectory.subagent_trajectories?.map(child => child.trajectory_id),
      ['planner', 'executor', 'verifier'].slice(0, index + 1))
    assert.equal(trajectory.steps[0].source, 'system')
    assert.equal(trajectory.steps[0].llm_call_count, 0)
    assert.equal(trajectory.steps[0].extra?.osworld_harness.provenance.model_visible, false)
    const stages = atifTrajectoryToSteps(trajectory).filter(item => item.role === 'agent')
    assert.deepEqual(stages.map(item => item.text), ['planner', 'executor', 'verifier'].slice(0, index + 1))
    assert.ok(stages.every(item => item.agent?.parentId === 'scheduler' && item.agent.delegationStepIndex == null))
    assert.equal(buildStepTree(atifTrajectoryToSteps(trajectory))[0].children.length, index + 1)
  }
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
  const steps = atifTrajectoryToSteps(fixture())
  steps[1].tokens = { prompt: 72_345, completion: 100 }
  steps[2].tokens = { prompt: 1_234_567, completion: 100 }
  const html = renderToStaticMarkup(<StepTimeline steps={steps} activeStep={1} labels={[]} aftSteps={new Set([1])} onSelect={() => {}} onCollapse={() => {}} />)
  assert.match(html, /Agent delegation tree/)
  assert.match(html, /Collapse agent gui_worker/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /from main/)
  assert.match(html, /Chronological/)
  assert.match(html, /aria-current="step"/)
  assert.match(html, /Collapse all/)
  assert.match(html, /Context size: 0.07M/)
  assert.match(html, /Context size: 1.23M/)
})

test('context size is formatted in millions with two decimals', () => {
  assert.equal(formatContextSize(72_345), '0.07M')
  assert.equal(formatContextSize(1_234_567), '1.23M')
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
    plan: { version: 1, task_contract: {
      review: 'approved',
      requirements: [{ id: 'R1', text: 'Apply the requested visible change', source: 'task', status: 'pending', claimed_by: [] }],
      deliverables: [{ id: 'D1', path: '/home/oai/share/result.odp', operation: 'modify_in_place' }],
      constraints: [], ambiguities: [],
    }, completed: [], remaining: [inspect, edit], next: inspect },
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
  assert.match(early, /Task contract/)
  assert.match(early, /Apply the requested visible change/)
  assert.match(early, /\/home\/oai\/share\/result.odp/)
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
  // A legacy execution-state/v1 feed is not one of the panel's inputs: it must
  // render nothing rather than pretending to be Planner or Observer state.
  const legacyFeed = { version: 'old', counts: { goal: 1 }, events: [{ event: 'execution_state_goal', sequence: 1, episode_elapsed_ms: 0, record: { statement: 'legacy goal' } }], terminal: true, duration_ms: 0 } as unknown as ExecutionStateFeed
  const html = renderToStaticMarkup(<ExecutionStatePanel feed={legacyFeed} playheadMs={0} onJump={() => {}} />)
  assert.match(html, /No Planner or Observer state recorded/)
  assert.doesNotMatch(html, /legacy goal|Goals/)
})

test('analysis job vocabulary comes from the backend and falls back for older backends', () => {
  // Published verdict wins over the status name: a cancelled job is terminal
  // even though the local fallback set is what older backends rely on.
  assert.equal(isTerminalJob({ job_id: 'j', status: 'cancelled' }), true)
  assert.equal(isTerminalJob({ job_id: 'j', status: 'running' }), false)
  assert.equal(isTerminalJob({ job_id: 'j', status: 'synthesizing', terminal: true }), true)
  assert.equal(isTerminalJob({ job_id: 'j', status: 'completed', terminal: false }), false)
  assert.equal(isTerminalJob(null), true)
  assert.equal(isActiveJob({ job_id: 'j', status: 'synthesizing' }), true)
  assert.equal(isActiveJob({ job_id: 'j', status: 'completed_partial' }), false)
  assert.equal(jobPhaseLabel({ job_id: 'j', status: 'running', progress: { phase: 'evidence-collection' } }), 'evidence-collection')
  assert.equal(jobPhaseLabel({ job_id: 'j', status: 'running', phase: 'preparing', phase_label: '准备轨迹' }), '准备轨迹')
  assert.equal(jobPhaseLabel(null, '排队中'), '排队中')
})

test('report freshness is tri-state and never invents staleness', () => {
  assert.equal(isStaleReport({ current: false }), true)
  assert.equal(isStaleReport({ current: true }), false)
  assert.equal(isStaleReport({}), false)
  assert.equal(isStaleReport({ current: null }), false)
  assert.equal(isStaleReport(null), false)
})

import type { AtifStep, AtifTrajectory } from './atif'

export interface AtifLiveStream {
  trace_format: 'atif-stream'
  stream_schema_version: 'osworld-atif-stream/v1'
  total_lines: number
  start_line: number
  terminal: boolean
  stream?: Record<string, unknown>
  records: Record<string, unknown>[]
}

type Loose = Record<string, any>

interface LiveDocument {
  id: string
  role: string
  origin?: string
  steps: AtifStep[]
}

function object(value: unknown): Loose {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Loose : {}
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function validStep(value: unknown): value is AtifStep {
  const step = object(value)
  return Number.isInteger(step.step_id)
    && step.step_id > 0
    && ['system', 'user', 'agent'].includes(step.source)
    && Object.prototype.hasOwnProperty.call(step, 'message')
}

function stepFor(document: LiveDocument, stepId: unknown): AtifStep | undefined {
  return Number.isInteger(stepId) ? document.steps[Number(stepId) - 1] : undefined
}

function putStep(document: LiveDocument, raw: unknown) {
  if (!validStep(raw)) return
  const step = clone(raw)
  if (step.step_id > document.steps.length + 1) return
  document.steps[step.step_id - 1] = step
  const harness = object(object(step.extra).osworld_harness)
  const provenance = object(harness.provenance)
  if (typeof provenance.role === 'string') document.role = provenance.role
  if (typeof provenance.origin === 'string') document.origin = provenance.origin
}

function attachSubagent(
  documents: Map<string, LiveDocument>,
  parents: Map<string, { parentId: string; callId?: string }>,
  detail: Loose,
) {
  const childId = typeof detail.id === 'string' ? detail.id : undefined
  const parentId = typeof detail.parentAgentId === 'string' ? detail.parentAgentId : undefined
  const callId = typeof detail.parentToolCallId === 'string' ? detail.parentToolCallId : undefined
  if (!childId || !parentId) return
  parents.set(childId, { parentId, callId })
  const child = documents.get(childId)
  if (child && typeof detail.agent === 'string') child.role = detail.agent
  if (!callId) return
  const parent = documents.get(parentId)
  const step = parent?.steps.find((candidate) => candidate.tool_calls?.some((call) => call.tool_call_id === callId))
  if (!step) return
  const observation = step.observation ??= { results: [] }
  let result = observation.results.find((candidate) => candidate.source_call_id === callId)
  if (!result) {
    result = { source_call_id: callId, content: '' }
    observation.results.push(result)
  }
  const refs = result.subagent_trajectory_ref ??= []
  if (!refs.some((ref) => ref.trajectory_id === childId)) refs.push({ trajectory_id: childId })
}

/** Materialize a viewer-safe ATIF snapshot from immutable live patch records. */
export function atifLiveToTrajectory(stream: AtifLiveStream): AtifTrajectory | null {
  const documents = new Map<string, LiveDocument>()
  const parents = new Map<string, { parentId: string; callId?: string }>()
  const harnessEvents: Loose[] = []
  const desktopFrames: Loose[] = []
  let sessionId: string | undefined

  const documentFor = (trajectoryId: unknown): LiveDocument | undefined => {
    if (typeof trajectoryId !== 'string' || !trajectoryId) return undefined
    let document = documents.get(trajectoryId)
    if (!document) {
      document = { id: trajectoryId, role: 'agent', steps: [] }
      documents.set(trajectoryId, document)
    }
    return document
  }

  for (const record of stream.records) {
    const patch = object(record)
    if (patch.trace_format !== 'atif-stream' || patch.stream_schema_version !== 'osworld-atif-stream/v1') continue
    const document = documentFor(patch.trajectory_id)
    if (patch.op === 'begin_step' || patch.op === 'append_step' || patch.op === 'upsert_step') {
      if (document) putStep(document, patch.step)
    } else if (patch.op === 'tool_execution_start' && document) {
      const step = stepFor(document, patch.step_id)
      const call = object(patch.tool_call)
      if (step && typeof call.tool_call_id === 'string') {
        const calls = step.tool_calls ??= []
        const index = calls.findIndex((candidate) => candidate.tool_call_id === call.tool_call_id)
        if (index >= 0) calls[index] = clone(call) as any
        else calls.push(clone(call) as any)
      }
    } else if (patch.op === 'tool_execution_end' && document) {
      const step = stepFor(document, patch.step_id)
      const result = object(patch.result)
      if (step && typeof result.source_call_id === 'string') {
        const results = (step.observation ??= { results: [] }).results
        const index = results.findIndex((candidate) => candidate.source_call_id === result.source_call_id)
        const priorRefs = index >= 0 ? results[index].subagent_trajectory_ref : undefined
        const next = clone(result) as any
        if (priorRefs?.length && !next.subagent_trajectory_ref) next.subagent_trajectory_ref = priorRefs
        if (index >= 0) results[index] = next
        else results.push(next)
      }
    } else if (patch.op === 'seal_step' && document) {
      const step = stepFor(document, patch.step_id)
      const harness = object(object(step?.extra).osworld_harness)
      if (step && Object.keys(harness).length) {
        harness.timing = clone(patch.timing)
        const provenance = object(harness.provenance)
        provenance.status = patch.status
      }
    } else if (patch.op === 'append_desktop_frame') {
      desktopFrames.push(clone(patch.frame))
    } else if (patch.op === 'append_harness_event') {
      const event = clone(object(patch.event))
      harnessEvents.push(event)
      const detail = object(event.record)
      if (event.event_type === 'subagent_lifecycle') attachSubagent(documents, parents, detail)
      if (typeof detail.sessionId === 'string') sessionId = detail.sessionId
    }
  }

  for (const [childId, parent] of parents) {
    attachSubagent(documents, parents, {
      id: childId, parentAgentId: parent.parentId, parentToolCallId: parent.callId,
    })
  }
  const complete = [...documents.values()].filter((document) => (
    document.steps.length > 0 && document.steps.every((step, index) => step?.step_id === index + 1)
  ))
  if (!complete.length) return null
  const root = complete.find((document) => !parents.has(document.id)) ?? complete[0]
  const toTrajectory = (document: LiveDocument, ancestors = new Set<string>()): AtifTrajectory => {
    const path = new Set(ancestors).add(document.id)
    const children = complete.filter((candidate) => (
      parents.get(candidate.id)?.parentId === document.id && !path.has(candidate.id)
    ))
    return {
      schema_version: 'ATIF-v1.8',
      session_id: sessionId,
      trajectory_id: document.id,
      agent: {
        name: 'osworld-stateact', version: 'live',
        extra: { osworld_harness: {
          role: document.role, agent_id: document.id,
          ...(document.origin ? { origin: document.origin } : {}),
        } },
      },
      steps: document.steps,
      ...(children.length ? {
        subagent_trajectories: children.map((child) => toTrajectory(child, path)),
      } : {}),
    }
  }
  const trajectory = toTrajectory(root)
  trajectory.final_metrics = { total_steps: complete.reduce((total, document) => total + document.steps.length, 0) }
  trajectory.extra = { osworld_harness: {
    schema_version: 'osworld-harness/v1',
    trace_format: 'atif',
    clock: { field: 'episode_elapsed_ms', unit: 'ms', origin: 'episode_start' },
    source: { format: 'atif', adapter: 'omp-native-live/v1' },
    live_stream_schema_version: stream.stream_schema_version,
    run: { execution_status: stream.terminal ? 'terminal' : 'running', terminal: stream.terminal },
    events: harnessEvents,
    desktop_timeline: {
      schema_version: 'desktop-timeline/v1', clock: 'episode_elapsed_ms',
      frames: desktopFrames, total_frames: desktopFrames.length,
      status: desktopFrames.length ? 'enabled' : 'disabled', terminal: stream.terminal, warnings: [],
    },
  } }
  return trajectory
}

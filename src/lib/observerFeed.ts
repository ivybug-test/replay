import type { AtifTrajectory } from './atif'
import type { PlannerStateV1 } from './osworldAtifExtra'
import type { ExecutionStateEvent } from './ossReplay'

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

/** Read spectator reports from the same Harness history in live and archived ATIF. */
export function observerEvents(trajectory: AtifTrajectory): ExecutionStateEvent[] {
  const harness = object(trajectory.extra?.osworld_harness)
  const history: Record<string, any>[] = Array.isArray(harness.events) ? harness.events : []
  const times = new Map(history.map(event => [event.sequence, event.episode_elapsed_ms]))
  const events: ExecutionStateEvent[] = []
  for (const event of history) {
    if (event.event_type !== 'observer_interval') continue
    const record = object(object(event.record).record)
    if (!Number.isInteger(record.interval_id)) continue
    events.push({
      event: 'observer_interval', sequence: event.sequence,
      episode_elapsed_ms: times.get(record.end_sequence) ?? event.episode_elapsed_ms ?? 0,
      record,
    })
  }
  // Some archives preserve only the latest snapshot. Do not duplicate its history entry.
  const latest = object(object(harness.state).observer)
  if (typeof latest.description === 'string' && !events.some(event => event.record?.interval_id === latest.interval_id)) {
    events.push({ event: 'observer_interval', sequence: latest.end_sequence ?? 0,
      episode_elapsed_ms: times.get(latest.end_sequence) ?? harness.run?.duration_ms ?? 0,
      record: { ...latest, status: 'completed' } })
  }
  return events.sort((a, b) => Number(a.record?.interval_id) - Number(b.record?.interval_id))
}

/** Read Harness-owned Planner snapshots without inspecting executor trajectories. */
export function plannerEvents(trajectory: AtifTrajectory): ExecutionStateEvent[] {
  const harness = object(trajectory.extra?.osworld_harness)
  const history: Record<string, any>[] = Array.isArray(harness.events) ? harness.events : []
  const events: ExecutionStateEvent[] = history.filter(event => event.event_type === 'planner_state')
    .filter(event => object(event.record).schema_version === 'planner-state/v1')
    .map(event => ({
      event: 'planner_state' as const,
      sequence: Number(event.sequence) || 0,
      episode_elapsed_ms: Number(event.episode_elapsed_ms) || 0,
      ...(typeof event.time === 'string' ? { time: event.time } : {}),
      ...(typeof event.actor === 'string' ? { actor: event.actor } : {}),
      record: event.record as PlannerStateV1,
    }))
  const latest = object(object(harness.state).planner) as Partial<PlannerStateV1>
  if (latest.schema_version === 'planner-state/v1' && !events.some(event => (
    event.record?.tool_call_id === latest.tool_call_id
    && event.record?.cause === latest.cause
    && object(event.record?.plan).version === latest.plan?.version
  ))) {
    events.push({
      event: 'planner_state', sequence: 0,
      episode_elapsed_ms: Number(harness.run?.duration_ms) || 0,
      record: latest as PlannerStateV1,
    })
  }
  return events.sort((a, b) => a.episode_elapsed_ms - b.episode_elapsed_ms || a.sequence - b.sequence)
}

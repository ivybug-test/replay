import type { AtifTrajectory } from './atif'
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

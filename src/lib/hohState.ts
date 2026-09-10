import type { AtifTrajectory } from './atif'
import type { ExecutionStateEvent } from './ossReplay'

export interface HohArtifact { id: string; description: string; requirements: string[]; file_path?: string }
export interface HohTaskItem { target: string | { artifact_ids: string[]; description: string }; preserve: string[]; gate: string[] }
export interface HohClaim {
  id: string; artifact_ids?: string[]; claim: string; reason?: string
  kind?: 'basis' | 'delivery'; source_files?: string[]
  evidence?: { ref: string; observation: string }[]
}
export interface HohState {
  loop: number; revision?: number; stage: string; done?: boolean
  artifacts?: HohArtifact[]; task_items?: HohTaskItem[]
  verified?: HohClaim[]; gaps?: HohClaim[]; claims?: HohClaim[]
  invalidated_verified: string[]
  artifact_changes: { artifact_id: string; reason: string }[]
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

/** Fold only committed Harness stage records. Model drafts and yield arguments are not state. */
export function hohEvents(trajectory: AtifTrajectory): ExecutionStateEvent[] {
  const harness = object(trajectory.extra?.osworld_harness)
  const history = (Array.isArray(harness.events) ? harness.events : []) as Record<string, any>[]
  let state: HohState | undefined
  const events: ExecutionStateEvent[] = []
  for (const event of [...history].sort((a, b) => a.episode_elapsed_ms - b.episode_elapsed_ms || a.sequence - b.sequence)) {
    if (event.event_type !== 'subagent_lifecycle') continue
    const record = object(event.record)
    const hoh = object(record.hoh)
    if (!Number.isInteger(hoh.loop)) continue
    const plan = object(hoh.planner_output)
    const verification = object(hoh.verification)
    const hasPlan = Array.isArray(plan.task_items)
    const hasVerification = Array.isArray(verification.verified) && Array.isArray(verification.gaps)
    const hasInvalidation = Array.isArray(hoh.invalidated_verified)
    const hasClaims = Array.isArray(hoh.claims)
    if (!hasPlan && !hasVerification && !hasInvalidation && !hasClaims) continue
    state = { ...state, loop: hoh.loop, stage: String(record.agent ?? 'Harness'),
      invalidated_verified: [], artifact_changes: [],
      ...(Number.isInteger(hoh.state_revision) ? { revision: hoh.state_revision } : {}) }
    if (hasPlan) {
      state.task_items = plan.task_items
      state.done = plan.done === true
      if (Array.isArray(plan.artifacts) && state.artifacts === undefined) {
        state.artifacts = plan.artifacts
        state.verified ??= []
        state.gaps ??= []
      }
      // Earlier HoH versions committed these collections through Planner.
      if (Array.isArray(plan.verified)) state.verified = plan.verified
      if (Array.isArray(plan.gaps)) state.gaps = plan.gaps
    }
    if (hasInvalidation) {
      state.invalidated_verified = hoh.invalidated_verified
      state.artifact_changes = Array.isArray(hoh.artifact_changes) ? hoh.artifact_changes : []
      const removed = new Set(state.invalidated_verified)
      state.verified = state.verified?.filter(claim => !removed.has(claim.id))
    }
    if (hasVerification) {
      state.verified = verification.verified
      state.gaps = verification.gaps
    }
    if (hasClaims) state.claims = hoh.claims
    events.push({ event: 'hoh_state', sequence: Number(event.sequence) || 0,
      episode_elapsed_ms: Number(event.episode_elapsed_ms) || 0, record: { ...state } })
  }
  return events
}

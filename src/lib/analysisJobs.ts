// Analysis job vocabulary. The backend owns it and publishes `terminal`,
// `phase` and `phase_label` on every job; these helpers exist so the UI reads
// that verdict instead of keeping a copy. The local set only covers a backend
// that predates those fields.
import type { AnalysisJob } from './ossReplay'

const FALLBACK_TERMINAL_JOBS = new Set(['completed', 'completed_partial', 'failed', 'cancelled'])

export function isTerminalJob(job: AnalysisJob | null | undefined): boolean {
  if (!job) return true
  return job.terminal ?? FALLBACK_TERMINAL_JOBS.has(job.status)
}

export function isActiveJob(job: AnalysisJob | null | undefined): boolean {
  return !!job && !isTerminalJob(job)
}

export function jobPhaseLabel(job: AnalysisJob | null | undefined, fallback = ''): string {
  if (!job) return fallback
  return job.phase_label ?? job.progress?.phase ?? job.stage ?? job.status ?? fallback
}

/** A report with `current === false` is known to be stale; null/undefined means unknown. */
export function isStaleReport(report: { current?: boolean | null } | null | undefined): boolean {
  return report?.current === false
}

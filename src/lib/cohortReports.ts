export interface CohortReportSummary {
  report_id: string
  analysis_type: 'todolist-quality'
  run_id: string
  revision: number
  title: string
  summary: string
  created_at: string
}

export interface CohortReport extends CohortReportSummary {
  content: string
  document: Record<string, unknown>
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`Replay API returned HTTP ${response.status}`)
  return response.json() as Promise<T>
}

export function fetchCohortReports(signal?: AbortSignal) {
  return getJson<{ reports: CohortReportSummary[] }>('/api/cohort-reports', signal)
}

export function fetchCohortReport(reportId: string, signal?: AbortSignal) {
  return getJson<CohortReport>(`/api/cohort-reports/${encodeURIComponent(reportId)}`, signal)
}

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowUpRight, FileText, Layers3 } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import Markdown from '../components/Markdown'
import { Loading } from '../components/ui'
import { fetchCohortReport, type CohortReport } from '../lib/cohortReports'

export default function CohortReportDetail() {
  const { reportId = '' } = useParams()
  const [report, setReport] = useState<CohortReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetchCohortReport(reportId, controller.signal).then(setReport)
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [reportId])
  const sourceRuns = report?.document.source_run_ids
  return <>
    <PageHeader title={report?.title ?? 'Cohort report'} subtitle={report?.summary ?? reportId}
      actions={report ? <Link className="btn-secondary" to={`/live/runs/${encodeURIComponent(report.run_id)}`}>
        打开主 Run <ArrowUpRight size={13} />
      </Link> : null} />
    {error ? <div className="p-8 text-sm text-rose-300">{error}</div> : !report ? (
      <Loading label="正在加载 Cohort 报告…" />
    ) : <div className="mx-auto max-w-6xl space-y-5 p-8">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-600">
        <span className="chip bg-violet-500/10 text-violet-300"><Layers3 size={11} /> Cohort report</span>
        <span>{report.analysis_type}</span><span>revision {report.revision}</span>
        <span>{new Date(report.created_at).toLocaleString()}</span>
        {Array.isArray(sourceRuns) && <span>{sourceRuns.length} source runs</span>}
      </div>
      <article className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-6 py-4">
          <FileText size={15} className="text-violet-300" />
          <h2 className="text-sm font-semibold text-zinc-200">Todolist 质量分析</h2>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-zinc-700">structured + rendered</span>
        </div>
        <div className="p-6 md:p-8"><Markdown content={report.content} /></div>
      </article>
    </div>}
  </>
}

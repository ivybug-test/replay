import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Activity, AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, FileText, RotateCcw, Target } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import Markdown from '../components/Markdown'
import { Loading } from '../components/ui'
import {
  fetchAftReport, fetchRunAnalysis, startRunAnalysis,
  type AftRunReport, type AftRunStatus,
} from '../lib/ossReplay'
import { isActiveJob, isStaleReport, isTerminalJob } from '../lib/analysisJobs'

function displayNumber(value: unknown, digits = 0) {
  return typeof value === 'number' ? value.toFixed(digits) : '—'
}

function duration(value: unknown) {
  if (typeof value !== 'number') return '—'
  const minutes = Math.floor(value / 60_000)
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

export default function AftReportDetail() {
  const { reportId = '' } = useParams()
  const navigate = useNavigate()
  const [report, setReport] = useState<AftRunReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<AftRunStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [pollRevision, setPollRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    fetchAftReport(reportId, controller.signal).then((payload) => {
      setReport(payload)
      if (payload.report_id !== reportId) {
        navigate(`/aft-reports/${encodeURIComponent(payload.report_id)}`, { replace: true })
      }
    })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [navigate, reportId])
  useEffect(() => {
    if (!report?.run_id) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    fetchRunAnalysis(report.run_id, controller.signal).then((next) => {
      if (controller.signal.aborted) return
      setRunStatus({ job: next.job, report: next.report })
      if (next.report?.report_id && next.report.report_id !== report.report_id
          && isTerminalJob(next.job)) {
        navigate(`/aft-reports/${encodeURIComponent(next.report.report_id)}`, { replace: true })
        return
      }
      if (isActiveJob(next.job)) {
        timer = setTimeout(() => setPollRevision((value) => value + 1), 3000)
      }
    }).catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [navigate, pollRevision, report?.report_id, report?.run_id])
  const active = isActiveJob(runStatus?.job)
  const jobFailed = !!runStatus?.job && ['failed', 'cancelled'].includes(runStatus.job.status)
  const regenerate = async () => {
    if (!report) return
    setStarting(true)
    setError(null)
    try {
      // Force only when the report is known to be stale or the last attempt
      // failed; otherwise let the backend reuse a current report.
      const next = await startRunAnalysis(
        report.run_id, report.model, undefined, isStaleReport(report) || jobFailed,
      )
      setRunStatus({ job: next.job, report: next.report })
      setPollRevision((value) => value + 1)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setStarting(false)
    }
  }
  const progress = runStatus?.job?.progress
  const taskProgress = progress?.task_reports
  const summary = report?.document.summary ?? {}
  return <>
    <PageHeader title="AFT Run 分析报告" subtitle={report?.run_id ?? reportId}
      actions={report ? <div className="flex items-center gap-2">
        <button className="btn-secondary" disabled={starting || active} onClick={() => void regenerate()}>
          <RotateCcw size={13} />{starting ? '正在启动…' : active ? '正在重新生成' : '重新生成'}
        </button>
        <Link className="btn-secondary" to={`/live/runs/${encodeURIComponent(report.run_id)}`}>
          打开 Run <ArrowUpRight size={13} />
        </Link>
      </div> : null} />
    {error ? <div className="p-8 text-sm text-rose-300">{error}</div> : !report ? (
      <Loading label="正在加载 Run 报告…" />
    ) : <div className="mx-auto max-w-6xl space-y-5 p-8">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-600">
        {isStaleReport(report)
          ? <span className="chip bg-amber-500/10 text-amber-300"><AlertTriangle size={11} /> 报告已过期</span>
          : <span className="chip bg-emerald-500/10 text-emerald-300"><CheckCircle2 size={11} /> 后端分析完成</span>}
        <span className="text-zinc-400">{report.model}</span><span>{report.taxonomy_version}</span>
        <span>revision {report.revision}</span><span>{new Date(report.created_at).toLocaleString()}</span>
      </div>
      {active && <div className="space-y-3 rounded-xl border border-accent/20 bg-accent/[0.035] p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-2 font-medium text-accent"><Activity size={12} className="animate-pulse" />正在重新生成 Run 报告</span>
          <span className="tabular-nums text-zinc-500">{progress?.percent != null ? `${progress.percent}%` : `${taskProgress?.completed ?? 0}/${taskProgress?.total ?? '—'} Tasks`}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-ink-700"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress?.percent ?? 5}%` }} /></div>
        <p className="text-[11px] text-zinc-600">生成期间保留当前 revision，完成后自动切换到新 revision。</p>
      </div>}
      {runStatus?.job && ['failed', 'cancelled'].includes(runStatus.job.status) && <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-xs text-rose-200">
        重新生成失败：{runStatus.job.error?.message || runStatus.job.status}
      </div>}
      <div className="card grid overflow-hidden sm:grid-cols-4">
        {[
          { Icon: FileText, label: '已分析任务', value: `${summary.analyzed ?? '—'} / ${summary.task_count ?? '—'}` },
          { Icon: Target, label: '平均得分', value: displayNumber(summary.average_score, 3) },
          { Icon: CheckCircle2, label: '失败任务', value: displayNumber(summary.failed) },
          { Icon: Clock3, label: '总运行时间', value: duration(summary.total_duration_ms) },
        ].map(({ Icon, label, value }, index) => <div key={label} className={`flex items-center gap-3 px-4 py-4 ${index < 3 ? 'border-r border-line' : ''}`}>
          <Icon size={15} className="shrink-0 text-zinc-600" />
          <div><div className="text-lg font-semibold tabular-nums text-white">{value}</div><div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div></div>
        </div>)}
      </div>
      <article className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-6 py-4">
          <FileText size={15} className="text-accent" />
          <h2 className="text-sm font-semibold text-zinc-200">分析报告</h2>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-zinc-700">证据可回溯</span>
        </div>
        <div className="p-6 md:p-8"><Markdown content={report.content} /></div>
      </article>
    </div>}
  </>
}

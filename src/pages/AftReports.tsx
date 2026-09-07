import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Activity, ArrowUpRight, ChevronRight, Database, FileText, Layers3, Search,
  ShieldCheck, Tags, type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Loading } from '../components/ui'
import {
  fetchAftReports, fetchAftRunStatuses, fetchProblemTags,
  type AftRunReportSummary, type AftRunStatus, type ProblemTag,
} from '../lib/ossReplay'
import { fetchCohortReports, type CohortReportSummary } from '../lib/cohortReports'

const TERMINAL_JOBS = new Set(['completed', 'completed_partial', 'failed', 'cancelled'])

const EDGE_COLORS = ['bg-sky-400', 'bg-violet-400', 'bg-amber-400', 'bg-fuchsia-400',
  'bg-cyan-400', 'bg-emerald-400', 'bg-indigo-400', 'bg-orange-400', 'bg-rose-400', 'bg-lime-400']

function MiniStat({ Icon, label, value, sub }: {
  Icon: LucideIcon; label: string; value: string | number; sub: string
}) {
  return <div className="flex min-w-0 items-center gap-3 border-r border-line px-5 py-4 last:border-r-0">
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink-800 text-zinc-400"><Icon size={15} /></span>
    <div className="min-w-0">
      <div className="text-lg font-semibold tabular-nums text-white">{value}</div>
      <div className="truncate text-[10px] uppercase tracking-wider text-zinc-600">{label} · {sub}</div>
    </div>
  </div>
}

export default function AftReports() {
  const [reports, setReports] = useState<AftRunReportSummary[] | null>(null)
  const [cohortReports, setCohortReports] = useState<CohortReportSummary[] | null>(null)
  const [tags, setTags] = useState<ProblemTag[] | null>(null)
  const [version, setVersion] = useState('')
  const [researchMapVersion, setResearchMapVersion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [taxonomyOpen, setTaxonomyOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [runStatuses, setRunStatuses] = useState<Record<string, AftRunStatus>>({})
  const [statusRevision, setStatusRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetchAftReports(controller.signal), fetchProblemTags(controller.signal),
      fetchAftRunStatuses(controller.signal), fetchCohortReports(controller.signal),
    ])
      .then(([reportPayload, tagPayload, statusPayload, cohortPayload]) => {
        setReports(reportPayload.reports)
        setCohortReports(cohortPayload.reports)
        setTags(tagPayload.tags)
        setRunStatuses(statusPayload.runs)
        setVersion(String(tagPayload.version.version_id ?? ''))
        setResearchMapVersion(tagPayload.research_map_version ?? '')
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (statusRevision === 0) return
    const controller = new AbortController()
    Promise.all([fetchAftRunStatuses(controller.signal), fetchAftReports(controller.signal)])
      .then(([statusPayload, reportPayload]) => {
        setRunStatuses(statusPayload.runs)
        setReports(reportPayload.reports)
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [statusRevision])

  const activeRuns = Object.entries(runStatuses).filter(([, value]) => (
    value.job && !TERMINAL_JOBS.has(value.job.status)
  ))
  useEffect(() => {
    if (!activeRuns.length) return
    const timer = setTimeout(() => setStatusRevision((value) => value + 1), 3000)
    return () => clearTimeout(timer)
  }, [activeRuns.length, statusRevision])

  const categories = useMemo(() => [...new Set((tags ?? []).map((tag) => tag.category))].sort(), [tags])
  const visibleTags = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (tags ?? []).filter((tag) => (category === 'all' || tag.category === category)
      && (!needle || [tag.tag_id, tag.name_en, tag.description, tag.fault_side ?? '']
        .some((value) => value.toLocaleLowerCase().includes(needle))))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name_en.localeCompare(b.name_en))
  }, [tags, query, category])
  const sourceCount = new Set(tags?.flatMap((tag) => tag.sources.map((source) => source.source_id)) ?? []).size

  return <>
    <PageHeader title="AFT reports" subtitle="Task-first common-problem analysis across OSWorld 2.0 runs."
      actions={<span className="chip bg-accent/10 text-accent"><ShieldCheck size={12} /> Backend native</span>} />
    {error ? <div className="p-8 text-sm text-rose-300">{error}</div> : reports == null || tags == null ? (
      <Loading label="Loading AFT reports…" />
    ) : cohortReports == null ? <Loading label="Loading cohort reports…" /> : <div className="mx-auto max-w-[1440px] space-y-6 p-8">
      {activeRuns.length > 0 && <section className="overflow-hidden rounded-xl border border-accent/20 bg-accent/[0.035]">
        <div className="flex items-center gap-2 border-b border-accent/15 px-5 py-3 text-sm font-semibold text-zinc-100">
          <Activity size={14} className="animate-pulse text-accent" /> 正在分析的 Run
          <span className="ml-auto text-xs font-normal tabular-nums text-zinc-600">{activeRuns.length}</span>
        </div>
        <div className="divide-y divide-accent/10">
          {activeRuns.map(([runId, status]) => {
            const job = status.job!
            const progress = job.progress
            const tasks = progress?.task_reports
            const percent = progress?.percent ?? (tasks?.total
              ? Math.max(2, Math.round(100 * (tasks.completed ?? 0) / tasks.total)) : 2)
            return <div key={runId} className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <Link to={`/live/runs/${encodeURIComponent(runId)}`} className="font-mono font-medium text-zinc-200 hover:text-accent">{runId}</Link>
                <span className="text-zinc-600">{job.model}</span>
                <span className="text-accent">{progress?.phase || job.stage || job.status}</span>
                <span className="ml-auto tabular-nums text-zinc-400">{percent}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-700"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} /></div>
              <div className="flex flex-wrap gap-x-4 text-[11px] text-zinc-600">
                {tasks?.total != null && <span>Task 报告：{tasks.completed ?? 0}/{tasks.total}</span>}
                {progress?.evidence_requests != null && <span>取证调用：{progress.evidence_requests}</span>}
                {progress?.task_analyses_read != null && <span>已读取 Task 分析：{progress.task_analyses_read}</span>}
              </div>
            </div>
          })}
        </div>
      </section>}
      <div className="card grid overflow-hidden sm:grid-cols-3">
        <MiniStat Icon={FileText} value={reports.length + cohortReports.length} label="Reports" sub="durable revisions" />
        <MiniStat Icon={Tags} value={tags.length} label="Taxonomy nodes" sub="source-grounded mappings" />
        <MiniStat Icon={Database} value={categories.length} label="Harness loci" sub={`${sourceCount} original sources`} />
      </div>

      <div className="flex flex-col gap-6">
        {cohortReports.length > 0 && <section className="card order-1 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Cohort reports</h2>
              <p className="mt-0.5 text-xs text-zinc-600">Independent cross-task analyses; not ordinary AFT run reports</p>
            </div>
            <Layers3 size={16} className="text-violet-300" />
          </div>
          <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
            {cohortReports.map((report) => <Link key={report.report_id}
              to={`/aft-reports/cohort/${encodeURIComponent(report.report_id)}`}
              className="group min-w-0 bg-panel px-5 py-4 transition-colors hover:bg-ink-800/70">
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-violet-400/20 bg-violet-500/10 text-violet-300">
                  <Layers3 size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-200">{report.title}</div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-600">{report.summary}</p>
                  <div className="mt-2 flex flex-wrap gap-x-2 text-[10px] text-zinc-600">
                    <span>{report.analysis_type}</span><span>revision {report.revision}</span>
                  </div>
                </div>
                <ArrowUpRight size={14} className="shrink-0 text-zinc-700 group-hover:text-violet-300" />
              </div>
            </Link>)}
          </div>
        </section>}
        <section className="card order-2 overflow-hidden" data-testid="aft-taxonomy">
          <button type="button" aria-expanded={taxonomyOpen} aria-controls="aft-taxonomy-content"
            onClick={() => setTaxonomyOpen((open) => !open)}
            className={clsx('w-full px-5 py-4 text-left transition-colors hover:bg-ink-800/45', taxonomyOpen && 'border-b border-line')}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Long-horizon harness taxonomy</h2>
                <p className="mt-0.5 text-xs text-zinc-600">先从近半年原文提取问题，再聚类为映射节点；节点本身不证明某个 Run 中发生了问题</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="font-mono text-[10px] text-zinc-600">{version} · {researchMapVersion}</span>
                <ChevronRight size={15} className={clsx('text-zinc-600 transition-transform', taxonomyOpen && 'rotate-90')} />
              </div>
            </div>
          </button>
          {taxonomyOpen && <div id="aft-taxonomy-content">
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-ink-950/35 px-4 py-3">
            <label className="relative min-w-52 flex-1">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input value={query} onChange={(event) => setQuery(event.target.value)}
                aria-label="Search problem tags" placeholder="Search tags, names, or definitions…"
                className="input w-full py-1.5 pl-8 text-xs" />
            </label>
            <select value={category} onChange={(event) => setCategory(event.target.value)}
              aria-label="Filter taxonomy category" className="input py-1.5 text-xs">
              <option value="all">All harness loci</option>
              {categories.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <span className="w-16 text-right text-[11px] tabular-nums text-zinc-600">{visibleTags.length} / {tags.length}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left">
              <thead className="bg-ink-950/55 text-[10px] uppercase tracking-wider text-zinc-600">
                <tr><th className="px-4 py-2.5 font-medium">Normalized problem</th><th className="px-3 py-2.5 font-medium">Harness locus</th><th className="px-3 py-2.5 font-medium">Mapping scope</th><th className="px-4 py-2.5 text-right font-medium">Original evidence</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visibleTags.map((tag) => {
                  const color = EDGE_COLORS[categories.indexOf(tag.category) % EDGE_COLORS.length] ?? 'bg-zinc-400'
                  const isOpen = expanded === tag.tag_id
                  const supportingSources = tag.sources.filter((source) => source.support_kind === 'supporting')
                  return <Fragment key={tag.tag_id}>
                    <tr data-taxonomy-row={tag.tag_id} onClick={() => setExpanded(isOpen ? null : tag.tag_id)}
                      className="cursor-pointer align-top transition-colors hover:bg-ink-800/45">
                      <td className="px-4 py-3.5">
                        <div className="flex items-start gap-2.5">
                          <ChevronRight size={13} className={clsx('mt-0.5 shrink-0 text-zinc-600 transition-transform', isOpen && 'rotate-90')} />
                          <div className="min-w-0"><div className="font-medium text-zinc-200">{tag.name_zh} <span className="ml-1.5 text-xs font-normal text-zinc-600">{tag.name_en}</span></div><p className="mt-1 max-w-4xl text-xs leading-relaxed text-zinc-500">{tag.description}</p></div>
                        </div>
                      </td>
                      <td className="px-3 py-3.5"><span className="inline-flex items-center gap-1.5 text-xs text-zinc-400"><span className={clsx('h-1.5 w-1.5 rounded-full', color)} />{tag.category}</span></td>
                      <td className="px-3 py-3.5 text-xs text-zinc-400">{tag.fault_side}</td>
                      <td className="px-4 py-3.5 text-right text-xs text-zinc-500">{supportingSources.length} supporting</td>
                    </tr>
                    {isOpen && <tr data-taxonomy-detail={tag.tag_id} className="bg-ink-950/55"><td colSpan={4} className="px-9 py-4">
                      <div>
                        <div className="mb-2 text-[10px] uppercase tracking-wider text-zinc-600">支持这一 Harness 判断与改动方向的具体章节</div>
                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {supportingSources.map((source) => {
                            const content = <><div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-wider text-zinc-600"><span className="truncate">{source.organization || 'Independent'}</span><span>{source.authority_tier || 'source'}</span></div><div className="mt-1 leading-relaxed text-zinc-300">{source.title}</div>{source.support_locator && <div className="mt-1 font-mono text-[10px] text-emerald-400">↳ {source.support_locator}</div>}{source.support_note && <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">{source.support_note}</p>}</>
                            return source.url.startsWith('local:')
                              ? <div key={source.source_id} className="rounded-md border border-ink-800 bg-ink-900/70 px-3 py-2">{content}</div>
                              : <a key={source.source_id} href={source.support_url || source.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="group/source rounded-md border border-ink-800 bg-ink-900/70 px-3 py-2 transition-colors hover:border-accent/30 hover:bg-ink-800">{content}<ArrowUpRight size={10} className="mt-1 text-zinc-700 group-hover/source:text-accent" /></a>
                          })}
                        </div>
                      </div>
                    </td></tr>}
                  </Fragment>
                })}
              </tbody>
            </table>
            {visibleTags.length === 0 && <div className="px-5 py-12 text-center text-sm text-zinc-600">No tags match this filter.</div>}
          </div>
          </div>}
        </section>

        <section className="card order-1 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Run reports</h2>
              <p className="mt-0.5 text-xs text-zinc-600">Newest analysis revisions first</p>
            </div>
            <Layers3 size={16} className="text-zinc-600" />
          </div>
          {reports.length === 0 ? <div className="px-5 py-12 text-center">
            <FileText size={22} className="mx-auto text-zinc-700" />
            <p className="mt-3 text-sm text-zinc-400">No completed run reports yet</p>
            <p className="mt-1 text-xs text-zinc-600">Analyze a finished run from OSS runs.</p>
          </div> : <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
            {reports.map((report) => <Link key={report.report_id}
              to={`/aft-reports/${encodeURIComponent(report.report_id)}`}
              className="group flex min-w-0 items-center gap-3 bg-panel px-5 py-4 transition-colors hover:bg-ink-800/70">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-950 text-zinc-500 group-hover:border-accent/40 group-hover:text-accent">
                <FileText size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs font-medium text-zinc-200">{report.run_id}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-600">
                  <span className="text-zinc-400">{report.model}</span>
                  <span>revision {report.revision}</span>
                  <span>{new Date(report.created_at).toLocaleString()}</span>
                </div>
              </div>
              <ArrowUpRight size={14} className="shrink-0 text-zinc-700 transition-colors group-hover:text-accent" />
            </Link>)}
          </div>}
        </section>
      </div>
    </div>}
  </>
}

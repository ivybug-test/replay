import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Sparkles, ScrollText, Award, Table2, Globe, MonitorPlay, FileType2,
  MessagesSquare, Container, Code2, Layers, Gauge, type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Loading, Pill } from '../components/ui'
import { FORMAT_LABELS, fmtPct } from '../lib/format'
import { useDatasetStore, visibleTasks } from '../lib/dataset'
import { useAuth } from '../lib/auth'
import type { Run, Task } from '../lib/types'
import { osworldCapabilities, osworldCapabilityLabel } from '../lib/osworld'
import { fetchTaskStats, type TaskStatsPayload } from '../lib/ossReplay'

const DIFFICULTY: Record<string, string> = {
  easy: 'bg-emerald-500/15 text-emerald-300',
  medium: 'bg-amber-500/15 text-amber-300',
  hard: 'bg-rose-500/15 text-rose-300',
}

const OSWORLD_VENDOR_ID = 'osworld-v2'

interface Badge { key: string; Icon: LucideIcon; cls: string; title: string }

function scorePattern(stat: import('../lib/ossReplay').TaskStat | undefined) {
  if (!stat || stat.scored < 2) return null
  if (stat.full_marks >= 2) return { label: '经常满分', cls: 'bg-emerald-500/15 text-emerald-300' }
  if (stat.full_marks === 0 && stat.partials >= 2) return { label: '经常部分分', cls: 'bg-sky-500/15 text-sky-300' }
  if (stat.full_marks + stat.partials === 0) return { label: '多次零分', cls: 'bg-rose-500/15 text-rose-300' }
  return null
}

const LEGEND: Badge[] = [
  { key: 'aft', Icon: Sparkles, cls: 'bg-accent/15 text-accent', title: 'AFT analysis' },
  { key: 'log', Icon: ScrollText, cls: 'bg-sky-500/15 text-sky-300', title: 'Verifier log' },
  { key: 'reward', Icon: Award, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Graded / reward' },
  { key: 'sheet', Icon: Table2, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Spreadsheet' },
  { key: 'web', Icon: Globe, cls: 'bg-sky-500/15 text-sky-300', title: 'Web page' },
  { key: 'screen', Icon: MonitorPlay, cls: 'bg-violet-500/15 text-violet-300', title: 'Computer-use / screenshots' },
  { key: 'doc', Icon: FileType2, cls: 'bg-violet-500/15 text-violet-300', title: 'Document' },
  { key: 'chat', Icon: MessagesSquare, cls: 'bg-sky-500/15 text-sky-300', title: 'Simulated-user conversation' },
  { key: 'env', Icon: Container, cls: 'bg-amber-500/15 text-amber-300', title: 'Dockerfile environment' },
  { key: 'code', Icon: Code2, cls: 'bg-zinc-500/15 text-zinc-300', title: 'Code / diff files' },
  { key: 'multi', Icon: Layers, cls: 'bg-zinc-500/15 text-zinc-300', title: 'Multiple runs' },
  { key: 'metrics', Icon: Gauge, cls: 'bg-zinc-500/15 text-zinc-400', title: 'Metrics-only (no trajectory)' },
]

/** Detect which viewer features/components a task supports, from its runs + files. */
function taskBadges(task: Task, runs: Run[], aftIds: Set<string>): Badge[] {
  const b: Badge[] = []
  const editKinds = new Set<string>()
  let hasSteps = false
  for (const r of runs) {
    // Lazy runs carry stepCount but an empty inline steps array (the trajectory
    // lives in public/runs/<id>.json); uploaded/tour runs keep steps inline.
    if (r.stepCount > 0 || r.steps.length) hasSteps = true
    for (const s of r.steps) for (const e of s.edits ?? []) editKinds.add(e.t)
  }
  const has = (t: string) => editKinds.has(t)
  const fileKind = (k: string) => task.files.some((f) => f.kind === k)

  if (runs.some((r) => aftIds.has(r.id))) b.push({ key: 'aft', Icon: Sparkles, cls: 'bg-accent/15 text-accent', title: 'AFT analysis available' })
  if (runs.some((r) => r.grade?.summary || r.failureReason)) b.push({ key: 'log', Icon: ScrollText, cls: 'bg-sky-500/15 text-sky-300', title: 'Verifier log' })
  if (runs.some((r) => r.reward != null)) b.push({ key: 'reward', Icon: Award, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Graded / reward' })
  if (has('sheet') || has('formula') || fileKind('spreadsheet')) b.push({ key: 'sheet', Icon: Table2, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Spreadsheet' })
  if (has('web')) b.push({ key: 'web', Icon: Globe, cls: 'bg-sky-500/15 text-sky-300', title: 'Web page' })
  if (has('screenshot') || has('computer')) b.push({ key: 'screen', Icon: MonitorPlay, cls: 'bg-violet-500/15 text-violet-300', title: 'Computer-use / screenshots' })
  if (has('doc')) b.push({ key: 'doc', Icon: FileType2, cls: 'bg-violet-500/15 text-violet-300', title: 'Document' })
  if (runs.some((r) => r.multiUser || r.steps.filter((s) => s.role === 'user').length > 1)) b.push({ key: 'chat', Icon: MessagesSquare, cls: 'bg-sky-500/15 text-sky-300', title: 'Simulated-user conversation' })
  if (task.files.some((f) => /dockerfile|docker-compose/i.test(f.path))) b.push({ key: 'env', Icon: Container, cls: 'bg-amber-500/15 text-amber-300', title: 'Dockerfile environment' })
  if (fileKind('code') || fileKind('diff')) b.push({ key: 'code', Icon: Code2, cls: 'bg-zinc-500/15 text-zinc-300', title: 'Code / diff files' })
  if (runs.length > 1) b.push({ key: 'multi', Icon: Layers, cls: 'bg-zinc-500/15 text-zinc-300', title: `${runs.length} runs` })
  if (runs.length > 0 && !hasSteps) b.push({ key: 'metrics', Icon: Gauge, cls: 'bg-zinc-500/15 text-zinc-400', title: 'Metrics-only (no trajectory)' })
  return b
}

export default function Tasks() {
  const { data, error } = useDatasetStore()
  const { isMember } = useAuth()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [aftIds, setAftIds] = useState<Set<string>>(new Set())
  const [osworldFilters, setOsworldFilters] = useState<Set<string>>(new Set())
  const [osworldDifficulty, setOsworldDifficulty] = useState('')
  const [taskStats, setTaskStats] = useState<TaskStatsPayload | null>(null)
  const [taskStatsError, setTaskStatsError] = useState('')

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}aft/index.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((ids: string[]) => setAftIds(new Set(ids)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => {
      void fetchTaskStats(controller.signal).then((payload) => {
        setTaskStats(payload)
        setTaskStatsError('')
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setTaskStatsError(reason instanceof Error ? reason.message : 'Unknown error')
        }
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 30_000)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [])

  const runsByTask = useMemo(() => {
    const m = new Map<string, Run[]>()
    data?.runs.forEach((r) => { const a = m.get(r.taskId) ?? []; a.push(r); m.set(r.taskId, a) })
    return m
  }, [data])
  const statsByTask = useMemo(() => new Map(
    (taskStats?.tasks ?? []).map((stat) => [`${OSWORLD_VENDOR_ID}-${stat.task_id}`, stat]),
  ), [taskStats])

  if (error) return <div className="p-8 text-rose-400">Failed to load dataset: {error}</div>
  if (!data) return <Loading />

  const tasks = visibleTasks(data, isMember)
  const orderedVendors = [...data.vendors]
    .sort((a, b) => Number(b.id === OSWORLD_VENDOR_ID) - Number(a.id === OSWORLD_VENDOR_ID))
  const osworldTasks = tasks.filter((task) => task.source === 'osworld')
  const capabilityCounts = new Map<string, number>()
  for (const task of osworldTasks) {
    for (const capability of osworldCapabilities(task)) {
      capabilityCounts.set(capability, (capabilityCounts.get(capability) ?? 0) + 1)
    }
  }
  const matchesFilters = (task: Task) => task.source !== 'osworld' || (
    (!osworldDifficulty || task.difficulty === osworldDifficulty)
    && (osworldFilters.size === 0
      || osworldCapabilities(task).some((capability) => osworldFilters.has(capability)))
  )
  // group: vendor -> category -> tasks
  const byVendor = new Map<string, Map<string, Task[]>>()
  for (const t of tasks) {
    const cat = t.category?.trim() || 'Other'
    if (!byVendor.has(t.vendorId)) byVendor.set(t.vendorId, new Map())
    const cats = byVendor.get(t.vendorId)!
    if (!cats.has(cat)) cats.set(cat, [])
    if (matchesFilters(t)) cats.get(cat)!.push(t)
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={`${tasks.length} tasks · grouped by source · OSWorld capability and difficulty filters`}
      />
      <div className="space-y-6 p-8">
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">What the task badges mean</summary>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {LEGEND.map((l) => (
              <span key={l.key} className="flex items-center gap-1.5">
                <span className={'grid h-5 w-5 place-items-center rounded ' + l.cls}><l.Icon size={12} /></span>
                {l.title}
              </span>
            ))}
          </div>
        </details>
        {orderedVendors.map((vendor) => {
          const cats = byVendor.get(vendor.id)
          if (!cats) return null
          const vendorTaskCount = [...cats.values()].reduce((n, ts) => n + ts.length, 0)
          const vendorTotal = tasks.filter((task) => task.vendorId === vendor.id).length
          const isCollapsed = collapsed[vendor.id] ?? vendor.id !== OSWORLD_VENDOR_ID
          return (
            <section key={vendor.id} className="card overflow-hidden">
              <button
                onClick={() => setCollapsed((current) => ({
                  ...current,
                  [vendor.id]: !(current[vendor.id] ?? vendor.id !== OSWORLD_VENDOR_ID),
                }))}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-3 bg-ink-800/50 px-5 py-3 text-left hover:bg-ink-800"
              >
                <span className="text-zinc-500">{isCollapsed ? '▸' : '▾'}</span>
                <span className="font-semibold text-white">{vendor.name}</span>
                <span className="text-xs text-zinc-500">
                  {cats.size} {cats.size === 1 ? 'group' : 'groups'} · {vendorTaskCount}
                  {vendorTaskCount === vendorTotal ? '' : ` of ${vendorTotal}`} tasks
                </span>
              </button>

              {!isCollapsed && (
                <div className="divide-y divide-ink-800">
                  {vendor.coverage && (
                    <div className="bg-ink-900/40 px-5 py-2.5 text-xs leading-relaxed text-zinc-400">
                      <span className="mr-1.5 font-medium uppercase tracking-wide text-zinc-500">Coverage</span>
                      {vendor.coverage}
                    </div>
                  )}
                  {vendor.id === OSWORLD_VENDOR_ID && (
                    <div className="space-y-2 bg-ink-900/40 px-5 py-3">
                      {taskStatsError && (
                        <div role="alert" className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                          Run statistics are temporarily unavailable: {taskStatsError}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Capability filters</span>
                        {(osworldFilters.size > 0 || osworldDifficulty) && (
                          <button className="text-xs text-accent hover:underline" onClick={() => {
                            setOsworldFilters(new Set())
                            setOsworldDifficulty('')
                          }}>Clear filters</button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {[...capabilityCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([capability, count]) => {
                          const active = osworldFilters.has(capability)
                          return (
                            <button key={capability} type="button" aria-pressed={active}
                              onClick={() => setOsworldFilters((current) => {
                                const next = new Set(current)
                                next.has(capability) ? next.delete(capability) : next.add(capability)
                                return next
                              })}
                              className={active
                                ? 'rounded-full bg-accent px-3 py-1 text-xs font-medium text-ink-950'
                                : 'rounded-full border border-ink-600 px-3 py-1 text-xs text-zinc-300 hover:border-accent/60'}>
                              {osworldCapabilityLabel(capability)} · {count}
                            </button>
                          )
                        })}
                      </div>
                      <label className="flex items-center gap-3 text-xs text-zinc-400">
                        Difficulty
                        <select aria-label="Difficulty" value={osworldDifficulty} onChange={(event) => setOsworldDifficulty(event.target.value)}
                          className="rounded border border-ink-600 bg-ink-900 px-2 py-1 text-zinc-200">
                          <option value="">All difficulties</option>
                          {['easy', 'medium', 'hard'].map((difficulty) => (
                            <option key={difficulty} value={difficulty}>
                              {difficulty[0].toUpperCase() + difficulty.slice(1)} · {osworldTasks.filter((task) => task.difficulty === difficulty).length}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="text-[11px] text-zinc-600">Selecting multiple capabilities shows tasks matching any selected label.</p>
                    </div>
                  )}
                  {[...cats.entries()].map(([cat, ts]) => (
                    <div key={cat} className="px-5 py-4">
                      <div className="mb-3 flex items-center gap-2">
                        <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-400">{cat}</h3>
                        <span className="text-xs text-zinc-600">{ts.length}</span>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {ts.map((task) => {
                          const taskRuns = runsByTask.get(task.id) ?? []
                          const indexedStat = task.source === 'osworld' ? statsByTask.get(task.id) : undefined
                          const runCount = task.source === 'osworld' ? (indexedStat?.runs ?? 0) : taskRuns.length
                          const passRate = task.source === 'osworld'
                            ? indexedStat?.pass_rate
                            : (runCount ? taskRuns.filter((r) => r.passed).length / runCount : null)
                          const badges = taskBadges(task, task.source === 'osworld' ? [] : taskRuns, aftIds)
                          const pattern = scorePattern(indexedStat)
                          if (task.source === 'osworld' && indexedStat?.scored) {
                            badges.push({ key: 'reward', Icon: Award, cls: 'bg-emerald-500/15 text-emerald-300', title: `${indexedStat.scored} scored runs` })
                          }
                          if (task.source === 'osworld' && runCount > 1) {
                            badges.push({ key: 'multi', Icon: Layers, cls: 'bg-zinc-500/15 text-zinc-300', title: `${runCount} runs` })
                          }
                          return (
                            <Link
                              key={task.id}
                              to={`/tasks/${task.id}`}
                              className="flex flex-col rounded-lg border border-ink-700 p-4 transition-colors hover:border-accent/50 hover:bg-ink-800/40"
                            >
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Pill>{FORMAT_LABELS[task.source]}</Pill>
                                {pattern && <Pill className={pattern.cls}>{pattern.label}</Pill>}
                                {task.difficulty && (
                                  <Pill className={DIFFICULTY[task.difficulty.toLowerCase()] ?? ''}>
                                    {task.difficulty}
                                  </Pill>
                                )}
                              </div>
                              <h4 className="mt-2 line-clamp-2 text-sm font-medium text-white">{task.title}</h4>
                              {task.source === 'osworld' && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  <Pill className="bg-amber-500/15 text-amber-200">{String(task.metadata?.snapshot || 'Other')}</Pill>
                                  {osworldCapabilities(task).slice(0, 3).map((capability) => (
                                    <Pill key={capability}>{osworldCapabilityLabel(capability)}</Pill>
                                  ))}
                                  {osworldCapabilities(task).length > 3 && <Pill>+{osworldCapabilities(task).length - 3}</Pill>}
                                </div>
                              )}
                              {badges.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {badges.map((bd) => (
                                    <span key={bd.key} title={bd.title}
                                      className={'grid h-5 w-5 place-items-center rounded ' + bd.cls}>
                                      <bd.Icon size={12} />
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="mt-auto flex items-center justify-between border-t border-ink-800 pt-2.5 text-xs text-zinc-500">
                                <span>{task.files.length} files</span>
                                <span>{task.source === 'osworld' && !taskStats ? '— runs' : `${runCount} runs`}</span>
                                <span className="text-right">
                                  {task.source === 'osworld' && !taskStats
                                    ? (taskStatsError ? 'unavailable' : 'loading…')
                                    : runCount
                                      ? task.source === 'osworld'
                                        ? indexedStat?.mean_score == null
                                          ? <span title="No scored runs yet">not scored</span>
                                          : <span title={`满分 / 部分分 / 零分：${indexedStat.full_marks} / ${indexedStat.partials} / ${indexedStat.zeros}`}>
                                            平均 <span className="text-zinc-300">{fmtPct(indexedStat.mean_score)}</span>
                                            <span className="ml-1 text-zinc-600">· 满/部/零 {indexedStat.full_marks}/{indexedStat.partials}/{indexedStat.zeros}</span>
                                          </span>
                                        : passRate == null
                                          ? <span title="No scored runs yet">not scored</span>
                                          : <>pass <span className="text-zinc-300">{fmtPct(passRate)}</span></>
                                      : 'no runs'}
                                </span>
                              </div>
                            </Link>
                          )
                        })}
                      </div>
                      {ts.length === 0 && <p className="py-6 text-sm text-zinc-500">No tasks match these filters.</p>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}

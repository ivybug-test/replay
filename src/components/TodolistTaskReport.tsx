import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, ExternalLink,
  FileCheck2, Image, ListChecks, Search, Tags, TriangleAlert,
} from 'lucide-react'

type Level = 'ok' | 'minor' | 'severe'

interface Evidence {
  kind: 'screenshot' | 'artifact' | 'tool_result'
  replay_url: string
  step_id: number
  establishes: string
  remaining_unknowns: string
}

interface Rating {
  level: Level
  rationale: string
  instruction_evidence?: string
  plan_evidence?: string
}

interface TaskDossier {
  task_id: string
  instruction_summary: string
  pre_init_evidence: Evidence[]
  approved_plan: { summary: string; key_commitments: string[] }
  authoritative_todo: { phases: { name: string; items: string[] }[] }
  requirement_mapping: {
    requirement: string
    plan: string
    todo: string
    status: 'covered' | 'partial' | 'missing' | 'misunderstood'
    evidence: string
  }[]
  plan_to_todo: {
    preserved: string[]
    condensed: string[]
    dropped: string[]
    unsupported_additions: string[]
  }
  ratings: Record<string, Rating>
  execution_risks: string[]
  improved_todo: { phase: string; items: string[] }[]
}

export interface TodolistTaskDocument {
  schema_version: 'todolist-quality-task-report/v2'
  source_run_ids: string[]
  availability: { selected: number; rateable: number; missing: number }
  task_dossiers: TaskDossier[]
  recurring_mechanism_index: { mechanism: string; tasks: string[] }[]
  limitations: string[]
  validation_checks?: { rating_totals?: Record<Level, number> }
}

const RATING_LABELS: Record<string, string> = {
  logical_soundness: '逻辑是否站得住',
  instruction_coverage: '要求是否覆盖完整',
  instruction_alignment: '是否理解对了目标',
  internal_consistency: '步骤是否互相一致',
  completion_checks: '是否有完成检查',
  execution_path: '执行路线是否可行',
  step_order: '先后顺序是否合理',
  action_specificity: '动作是否够具体',
  environment_grounding: '是否贴合当前环境',
  tool_appropriateness: '工具选择是否合适',
}

const LEVEL_LABELS: Record<Level, string> = { ok: '通过', minor: '小问题', severe: '严重问题' }
const LEVEL_STYLE: Record<Level, string> = {
  ok: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300',
  minor: 'border-amber-400/20 bg-amber-500/10 text-amber-300',
  severe: 'border-rose-400/20 bg-rose-500/10 text-rose-300',
}
const STATUS_LABELS = { covered: '已覆盖', partial: '部分覆盖', missing: '缺失', misunderstood: '理解偏差' }

const ISSUE_CATEGORIES = [
  { name: 'Todo 丢失关键约束', description: '计划里有要求，但压缩成 todo 后变得过于笼统。', dimensions: ['instruction_coverage', 'action_specificity'] },
  { name: '执行路线不可靠', description: '步骤看似完整，但关键依赖、方法或回退方案可能直接导致失败。', dimensions: ['logical_soundness', 'execution_path'] },
  { name: '环境或工具假设', description: '在看到真实文件、页面或工具能力前，就假定它们可用。', dimensions: ['environment_grounding', 'tool_appropriateness'] },
  { name: '完成检查不足', description: '只写“验证完成”，没有逐条检查文件、数值、格式或最终状态。', dimensions: ['completion_checks'] },
  { name: '目标理解有偏差', description: '做法或回退方案改变了用户真正要求的结果。', dimensions: ['instruction_alignment'] },
  { name: '步骤顺序或一致性', description: '前置条件、不可逆操作或步骤之间的关系安排不合理。', dimensions: ['step_order', 'internal_consistency'] },
] as const

function severityCount(task: TaskDossier, level: Level) {
  return Object.values(task.ratings).filter((rating) => rating.level === level).length
}

function EvidenceLink({ evidence }: { evidence: Evidence }) {
  const Icon = evidence.kind === 'screenshot' ? Image : evidence.kind === 'artifact' ? FileCheck2 : ListChecks
  const label = evidence.kind === 'screenshot' ? '指令与截图' : evidence.kind === 'artifact' ? '获批计划' : 'Todo 初始化'
  return <a href={evidence.replay_url} target="_blank" rel="noreferrer"
    className="group rounded-lg border border-line bg-ink-950/40 p-3 transition-colors hover:border-violet-400/40 hover:bg-violet-500/[0.04]">
    <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
      <Icon size={13} className="text-violet-300" /> Turn {evidence.step_id} · {label}
      <ExternalLink size={11} className="ml-auto text-zinc-700 group-hover:text-violet-300" />
    </div>
    <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{evidence.establishes}</p>
  </a>
}

function RatingGrid({ ratings }: { ratings: Record<string, Rating> }) {
  return <div className="grid gap-2 lg:grid-cols-2">
    {Object.entries(ratings).map(([key, rating]) => <div key={key}
      className="rounded-lg border border-line bg-ink-950/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-zinc-200">{RATING_LABELS[key] ?? key}</span>
        <span className={clsx('rounded border px-2 py-0.5 text-[10px] font-medium', LEVEL_STYLE[rating.level])}>
          {LEVEL_LABELS[rating.level]}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{rating.rationale}</p>
    </div>)}
  </div>
}

function TaskDetail({ task }: { task: TaskDossier }) {
  const severe = severityCount(task, 'severe')
  const minor = severityCount(task, 'minor')
  return <div className="min-w-0 space-y-5">
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="rounded-lg bg-violet-500/15 px-2.5 py-1 font-mono text-sm font-semibold text-violet-200">{task.task_id}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug text-white">{task.instruction_summary}</h2>
          <div className="mt-2 flex gap-2 text-[10px]">
            {severe > 0 && <span className={clsx('rounded border px-2 py-0.5', LEVEL_STYLE.severe)}>{severe} 个严重问题</span>}
            {minor > 0 && <span className={clsx('rounded border px-2 py-0.5', LEVEL_STYLE.minor)}>{minor} 个小问题</span>}
            <span className={clsx('rounded border px-2 py-0.5', LEVEL_STYLE.ok)}>{severityCount(task, 'ok')} 项通过</span>
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-3">
        {task.pre_init_evidence.map((evidence) => <EvidenceLink key={`${evidence.kind}-${evidence.step_id}`} evidence={evidence} />)}
      </div>
    </section>

    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded-xl border border-emerald-400/15 bg-emerald-500/[0.045] p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300"><CheckCircle2 size={14} />做得好的地方</div>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{task.approved_plan.summary}</p>
      </section>
      <section className="rounded-xl border border-rose-400/15 bg-rose-500/[0.045] p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-rose-300"><TriangleAlert size={14} />最需要修正</div>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{task.plan_to_todo.dropped[0] ?? task.execution_risks[0]}</p>
      </section>
    </div>

    <section className="rounded-xl border border-line bg-panel p-5">
      <h3 className="text-sm font-semibold text-white">Plan 变成 Todo 时发生了什么</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg bg-ink-950/40 p-3"><div className="text-[10px] uppercase tracking-wider text-emerald-400">保留下来</div><p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{task.plan_to_todo.preserved.join('；')}</p></div>
        <div className="rounded-lg bg-ink-950/40 p-3"><div className="text-[10px] uppercase tracking-wider text-sky-400">被压缩</div><p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{task.plan_to_todo.condensed.join('；')}</p></div>
        <div className="rounded-lg bg-ink-950/40 p-3"><div className="text-[10px] uppercase tracking-wider text-rose-400">被丢掉</div><p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{task.plan_to_todo.dropped.join('；')}</p></div>
      </div>
    </section>

    <section className="rounded-xl border border-line bg-panel p-5">
      <h3 className="mb-3 text-sm font-semibold text-white">十项检查</h3>
      <RatingGrid ratings={task.ratings} />
    </section>

    <section className="rounded-xl border border-violet-400/15 bg-violet-500/[0.035] p-5">
      <h3 className="text-sm font-semibold text-white">建议改成这样的 Todo</h3>
      <div className="mt-3 space-y-3">
        {task.improved_todo.map((phase, index) => <div key={phase.phase} className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet-500/15 text-[11px] font-semibold text-violet-300">{index + 1}</span>
          <div><div className="text-xs font-medium text-zinc-200">{phase.phase}</div>
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-zinc-500">{phase.items.map((item) => <li key={item}>· {item}</li>)}</ul>
          </div>
        </div>)}
      </div>
    </section>

    <details className="rounded-xl border border-line bg-panel">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-zinc-300 hover:text-white">查看原始 Todo 和要求映射</summary>
      <div className="grid gap-5 border-t border-line p-5 lg:grid-cols-2">
        <div className="space-y-3">{task.authoritative_todo.phases.map((phase) => <div key={phase.name}>
          <div className="text-xs font-medium text-zinc-200">{phase.name}</div>
          <ul className="mt-1 space-y-1 text-xs text-zinc-500">{phase.items.map((item) => <li key={item}>· {item}</li>)}</ul>
        </div>)}</div>
        <div className="space-y-2">{task.requirement_mapping.map((row) => <div key={row.requirement} className="rounded-lg bg-ink-950/40 p-3">
          <div className="flex gap-2 text-xs font-medium text-zinc-200"><span>{row.requirement}</span><span className="ml-auto text-[10px] text-zinc-600">{STATUS_LABELS[row.status]}</span></div>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{row.todo}</p>
        </div>)}</div>
      </div>
    </details>
  </div>
}

export function isTodolistTaskDocument(value: unknown): value is TodolistTaskDocument {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.schema_version === 'todolist-quality-task-report/v2' && Array.isArray(record.task_dossiers)
}

export default function TodolistTaskReport({ document }: { document: TodolistTaskDocument }) {
  const tasks = document.task_dossiers
  const [selectedId, setSelectedId] = useState(tasks[0]?.task_id ?? '')
  const [query, setQuery] = useState('')
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return tasks.filter((task) => !needle || task.task_id.includes(needle) || task.instruction_summary.toLowerCase().includes(needle))
  }, [tasks, query])
  const selected = tasks.find((task) => task.task_id === selectedId) ?? visible[0] ?? tasks[0]
  const selectedIndex = tasks.indexOf(selected)
  const totals = document.validation_checks?.rating_totals
  const categories = useMemo(() => ISSUE_CATEGORIES.map((category) => {
    const affected = tasks.filter((task) => category.dimensions.some((key) => task.ratings[key]?.level !== 'ok'))
    const severe = affected.filter((task) => category.dimensions.some((key) => task.ratings[key]?.level === 'severe'))
    return { ...category, affected, severe: severe.length }
  }), [tasks])
  const categoryDetail = categories.find((category) => category.name === expandedCategory)

  return <div className="space-y-5">
    <section className="grid overflow-hidden rounded-xl border border-line bg-panel sm:grid-cols-4">
      {[['任务', document.availability.rateable, 'text-white'], ['通过', totals?.ok ?? 0, 'text-emerald-300'], ['小问题', totals?.minor ?? 0, 'text-amber-300'], ['严重问题', totals?.severe ?? 0, 'text-rose-300']].map(([label,value,color]) =>
        <div key={String(label)} className="border-b border-line px-5 py-4 last:border-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
          <div className={clsx('text-2xl font-semibold tabular-nums', color)}>{value}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
        </div>)}
    </section>
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2">
        <Tags size={14} className="text-violet-300" />
        <div>
          <h2 className="text-sm font-semibold text-white">问题类别总结</h2>
          <p className="mt-0.5 text-[11px] text-zinc-600">按问题出现的环节分类；同一个 task 可能属于多个类别。</p>
        </div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{categories.map((category) =>
        <div key={category.name} className="rounded-lg border border-line bg-ink-950/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs font-medium text-zinc-200">{category.name}</div>
            <div className="shrink-0 text-[10px] tabular-nums text-zinc-600">
              {category.affected.length} 个任务{category.severe > 0 && <span className="ml-1 text-rose-400">· {category.severe} 个严重</span>}
            </div>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{category.description}</p>
          <div className="mt-2 flex flex-wrap gap-1">{category.affected.map((task) =>
            <button key={task.task_id} type="button" onClick={() => setSelectedId(task.task_id)}
              className={clsx('rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors',
                category.dimensions.some((key) => task.ratings[key]?.level === 'severe')
                  ? 'bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
                  : 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/20')}>
              {task.task_id}
            </button>)}</div>
          <button type="button" onClick={() => setExpandedCategory((current) => current === category.name ? null : category.name)}
            className="mt-3 flex w-full items-center justify-between border-t border-line pt-2 text-[11px] text-zinc-500 hover:text-violet-300">
            查看逐项归类理由
            <ChevronRight size={12} className={clsx('transition-transform', expandedCategory === category.name && 'rotate-90')} />
          </button>
        </div>)}</div>
      {categoryDetail && <div className="mt-4 overflow-hidden rounded-lg border border-violet-400/20 bg-violet-500/[0.025]">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white">{categoryDetail.name}：逐项理由</div>
            <p className="mt-0.5 text-[11px] text-zinc-600">只列出触发这个类别的检查项；理由来自该 task 的独立评分。</p>
          </div>
          <span className="text-[10px] tabular-nums text-zinc-600">{categoryDetail.affected.length} tasks</span>
        </div>
        <div className="max-h-[560px] divide-y divide-line overflow-y-auto">{categoryDetail.affected.map((task) => {
          const reasons = categoryDetail.dimensions
            .map((key) => ({ key, rating: task.ratings[key] }))
            .filter(({ rating }) => rating && rating.level !== 'ok')
          return <div key={task.task_id} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <button type="button" onClick={() => setSelectedId(task.task_id)}
                className="rounded bg-violet-500/10 px-2 py-0.5 font-mono text-[11px] text-violet-300 hover:bg-violet-500/20">{task.task_id}</button>
              <div className="min-w-0 flex-1">
                <button type="button" onClick={() => setSelectedId(task.task_id)}
                  className="text-left text-xs font-medium text-zinc-200 hover:text-violet-300">{task.instruction_summary}</button>
                <div className="mt-2 space-y-2">{reasons.map(({ key, rating }) => <div key={key} className="grid gap-1 md:grid-cols-[150px_minmax(0,1fr)]">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-400">{RATING_LABELS[key] ?? key}</span>
                    <span className={clsx('rounded border px-1.5 py-0.5 text-[9px]', LEVEL_STYLE[rating.level])}>{LEVEL_LABELS[rating.level]}</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-500">{rating.rationale}</p>
                </div>)}</div>
                <div className="mt-2 flex flex-wrap gap-3 text-[10px]">{task.pre_init_evidence.map((evidence) =>
                  <a key={`${evidence.kind}-${evidence.step_id}`} href={evidence.replay_url} target="_blank" rel="noreferrer"
                    className="text-zinc-600 hover:text-violet-300">Turn {evidence.step_id} · {evidence.kind === 'screenshot' ? '截图' : evidence.kind === 'artifact' ? '计划' : 'todo'}</a>)}</div>
              </div>
            </div>
          </div>
        })}</div>
      </div>}
    </section>
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">跨任务的共同成因</div>
      <div className="mt-2 grid gap-2 lg:grid-cols-3">{document.recurring_mechanism_index.map((item) =>
        <div key={item.mechanism} className="rounded-lg bg-ink-950/35 p-3"><div className="text-xs font-medium text-zinc-300">{item.mechanism}</div><div className="mt-1 text-[10px] text-zinc-600">涉及 {item.tasks.length} 个任务</div></div>)}</div>
    </section>
    <div className="grid min-w-0 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="self-start rounded-xl border border-line bg-panel p-3 lg:sticky lg:top-5">
        <label className="relative block"><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 task…" className="input w-full py-2 pl-8 text-xs" />
        </label>
        <div className="mt-2 max-h-[66vh] space-y-1 overflow-y-auto pr-1">{visible.map((task) => <button key={task.task_id} type="button" onClick={() => setSelectedId(task.task_id)}
          className={clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors', selected?.task_id === task.task_id ? 'bg-violet-500/12 text-white' : 'text-zinc-500 hover:bg-ink-800 hover:text-zinc-300')}>
          <span className="font-mono text-[11px] text-violet-300">{task.task_id}</span><span className="min-w-0 flex-1 truncate text-xs">{task.instruction_summary}</span>
          {severityCount(task, 'severe') > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />}<ChevronRight size={12} />
        </button>)}</div>
      </aside>
      {selected && <div className="min-w-0">
        <TaskDetail task={selected} />
        <div className="mt-4 flex justify-between">
          <button type="button" disabled={selectedIndex <= 0} onClick={() => setSelectedId(tasks[selectedIndex - 1].task_id)} className="btn-secondary disabled:opacity-30"><ArrowLeft size={13} /> 上一个</button>
          <button type="button" disabled={selectedIndex >= tasks.length - 1} onClick={() => setSelectedId(tasks[selectedIndex + 1].task_id)} className="btn-secondary disabled:opacity-30">下一个 <ArrowRight size={13} /></button>
        </div>
      </div>}
    </div>
  </div>
}

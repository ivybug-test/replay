import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import {
  Activity, AlertTriangle, ArrowRight, CheckCircle2,
  GitBranch, ListTree, RotateCcw, Sparkles, Target,
} from 'lucide-react'
import Markdown from './Markdown'
import {
  fetchAnalysisModels, fetchExecutionAnalysis, startExecutionAnalysis,
  type AnalysisModel, type ExecutionAnalysisReport, type ExecutionAnalysisState,
} from '../lib/ossReplay'
import { fmtScore } from '../lib/format'
import { uniqueSortedTurnEvidence } from '../lib/analysisEvidence'
import { isActiveJob, isStaleReport, isTerminalJob, jobPhaseLabel } from '../lib/analysisJobs'

function reportContent(report: ExecutionAnalysisReport | null): string {
  return report?.content ?? report?.payload?.content ?? ''
}

function reportModel(report: ExecutionAnalysisReport | null): string | undefined {
  return report?.model ?? report?.payload?.model
}

function evidenceLinks(content: string, batchId: string, taskKey: string): string {
  return content.replace(/\]\(\/monitor\?([^)]+)\)/g, (whole, query: string) => {
    const params = new URLSearchParams(query.replaceAll('&amp;', '&'))
    const at = params.get('at')
    if (!at || !/^\d+$/.test(at)) return whole
    const href = `/live/runs/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskKey)}?at_ms=${at}`
    return `](${href})`
  })
}

interface NativeIssue {
  issue_id: string; summary: string; severity: string; confidence: number
  responsibility: string; expected_behavior: string; actual_behavior: string; impact: string
  harness_layer?: string | null
  harness_relationship?: 'direct_fault' | 'contributing_factor' | 'missing_guardrail' | 'observability_gap' | 'no_supported_harness_finding'
  harness_finding?: string
  harness_recommendation?: string
  tag_mapping?: { primary_tag?: string; secondary_tags?: string[]; rationale?: string }
  facets?: string[]
  evidence?: Array<{ turn_id: string; timestamp_ms: number; excerpt?: string }>
  supporting_sources?: NativeResearchSource[]
}

interface NativeResearchSource {
  source_id: string; title: string; url: string; organization?: string
  authority_tier?: string; support_note?: string; support_locator?: string
  support_url?: string
}

interface NativeTurn {
  turn_id: string; global_turn: number; trajectory_id: string; agent_name: string
  at_ms?: number | null; summary: string; action: string; outcome: string; assessment: string
}

interface NativeReport {
  schema_version: 'aft-task-report/v1'; executive_summary: string; score_analysis: string
  call_chain_analysis: string; issues: NativeIssue[]; turns: NativeTurn[]
  score_breakdown?: Array<{
    criterion: string; evaluator_basis: string; maximum_score: number
    awarded_score: number; loss_reason: string; related_turn_ids: string[]
  }>
  evaluator_source?: {
    available: boolean; task_path?: string | null; repository_revision?: string | null
    dependency_symbols?: string[]; reason?: string | null
  }
  analysis_workflow?: {
    mode: string; tool_call_count: number; full_turn_evidence_required?: boolean
    tool_calls?: Array<{ sequence: number; tool: string; success: boolean; duration_ms: number }>
  }
  trace: { turn_count: number; agent_count: number; agents: Array<{
    trajectory_id: string; name: string; role?: string; semantic_role?: string
    responsibility_summary?: string; assignment?: string; final_output?: string; depth: number
    parent?: { parent_trajectory_id?: string | null; parent_turn?: number | null } | null
  }>; call_edges?: Array<{
    parent_trajectory_id: string; child_trajectory_id: string
    parent_turn?: number | null; tool_call_id?: string | null; tool_name?: string | null
  }> }
  strengths?: string[]; recommendations?: string[]
  research_basis?: {
    version?: string
    definition_source?: NativeResearchSource | null
    methodology_sources?: NativeResearchSource[]
  }
  metrics?: { score?: number | null; status?: string; agent_outcome?: string; duration_ms?: number | null }
  analysis_input_quality?: {
    trace_coverage: number; missing_event_types: string[]
    provenance_complete: boolean; limits_mapping_confidence: boolean
  }
}

interface TaskExecutionReport {
  schema_version: 'task-execution-analysis/v1'
  conclusion: {
    summary: string; completion: string; execution_quality: string
    current_state: string; stuck: boolean; stuck_reason: string
  }
  main_issues: Array<{
    issue_id: string; title: string; description: string; impact: string
    severity: 'low' | 'medium' | 'high'; status: string; turn_ids: string[]
  }>
  call_relationships: {
    summary: string
    agents: Array<{ trajectory_id: string; role: string; assignment: string; work_summary: string; result_summary: string }>
    edges: Array<{ parent_trajectory_id: string; child_trajectory_id: string; dispatch_turn_id: string; request: string; result: string; usage: string }>
  }
  execution_phases: Array<{
    title: string; summary: string; result: string; status: string; turn_ids: string[]
  }>
  turns: Array<{
    turn_id: string; global_turn: number; trajectory_id: string; agent_name: string
    at_ms?: number | null; purpose: string; action: string; result: string
    progress: string; assessment: string
  }>
  evaluator_analysis: {
    score: number | null; summary: string; method: string
    criteria: Array<{ criterion: string; result: string; score: number | null; related_turn_ids: string[] }>
    execution_discrepancy: string
  }
}

function nativeReport(value: unknown): NativeReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const report = value as Partial<NativeReport>
  return report.schema_version === 'aft-task-report/v1' && Array.isArray(report.turns)
    && Array.isArray(report.issues) ? report as NativeReport : null
}

function taskExecutionReport(value: unknown): TaskExecutionReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const report = value as Partial<TaskExecutionReport>
  return report.schema_version === 'task-execution-analysis/v1'
    && !!report.conclusion && Array.isArray(report.main_issues)
    && Array.isArray(report.execution_phases) && Array.isArray(report.turns)
    && !!report.evaluator_analysis ? report as TaskExecutionReport : null
}

function clock(ms?: number | null): string {
  if (ms == null) return '时间未知'
  const seconds = Math.floor(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

function conciseChinese(value?: string): string | null {
  const text = value?.trim()
  return text && text.length <= 100 && /[\u3400-\u9fff]/.test(text) ? text : null
}

function turnSummary(turn: NativeTurn): string {
  const summary = conciseChinese(turn.summary)
  if (summary) return summary
  const tools = [...(turn.action || '').matchAll(/(?:^|[；；])\s*([A-Za-z_][\w.-]*)\s*\(/g)]
    .map((match) => match[1])
  const unique = [...new Set(tools)]
  if (unique.length) return `调用 ${unique.join('、')} 工具推进任务。`
  return turn.action ? '调用工具推进当前任务。' : '进行阶段性分析并决定下一步。'
}

function roleLabel(agent?: NativeReport['trace']['agents'][number]): string {
  return agent?.role || agent?.semantic_role || (agent?.depth ? 'coder' : 'planner')
}

function TaskExecutionAnalysis({ report, batchId, taskKey }: {
  report: TaskExecutionReport; batchId: string; taskKey: string
}) {
  const turnById = new Map(report.turns.map((turn) => [turn.turn_id, turn]))
  const href = (turnId: string) => {
    const turn = turnById.get(turnId)
    const query = new URLSearchParams({ at_ms: String(turn?.at_ms ?? 0) })
    if (turn) query.set('turn', String(turn.global_turn))
    return `/live/runs/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskKey)}?${query}`
  }
  const turnLinks = (ids: string[]) => ids.map((id) => {
    const turn = turnById.get(id)
    return <Link key={id} to={href(id)} className="chip border border-sky-500/15 bg-sky-500/10 text-sky-300 hover:border-sky-400/40">
      Turn {turn?.global_turn ?? id.split(':').slice(-1)[0]} <ArrowRight size={10} />
    </Link>
  })
  const assessmentColor: Record<string, string> = {
    effective: 'bg-emerald-400', problematic: 'bg-rose-400', ineffective: 'bg-orange-400',
    administrative: 'bg-zinc-500', unclear: 'bg-zinc-600',
  }
  return <div className="space-y-5">
    <section className="relative overflow-hidden rounded-xl border border-accent/25 bg-accent/[0.045] p-4 pl-5">
      <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
      <div className="text-[10px] font-semibold uppercase tracking-widest text-accent">结论</div>
      <p className="mt-2 text-sm font-medium leading-relaxed text-zinc-200">{report.conclusion.summary}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-zinc-500">
        <span className="chip">完成度 {report.conclusion.completion}</span>
        <span className="chip">执行质量 {report.conclusion.execution_quality}</span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-zinc-400">{report.conclusion.current_state}</p>
      {report.conclusion.stuck && <p className="mt-2 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-200">
        卡死或阻塞：{report.conclusion.stuck_reason || '原因不明'}
      </p>}
    </section>

    <section>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500"><AlertTriangle size={14} /> 主要问题</h3>
      <div className="mt-2 space-y-2">{report.main_issues.length ? report.main_issues.map((issue) =>
        <div key={issue.issue_id} className="rounded-xl border border-amber-500/20 bg-amber-500/[0.025] p-3.5">
          <div className="flex items-start justify-between gap-3"><div className="text-sm font-medium text-zinc-100">{issue.title}</div><span className="text-[10px] uppercase text-zinc-600">{issue.severity} · {issue.status}</span></div>
          <p className="mt-2 text-xs leading-relaxed text-zinc-400">{issue.description}</p>
          <p className="mt-1 text-xs text-zinc-500">影响：{issue.impact}</p>
          {!!issue.turn_ids.length && <div className="mt-2 flex flex-wrap gap-1.5">{turnLinks(issue.turn_ids)}</div>}
        </div>) : <p className="rounded-lg border border-line bg-ink-950/70 px-3 py-3 text-xs text-zinc-500">未发现有明确轨迹证据支持的主要问题。</p>}
      </div>
    </section>

    <details open className="overflow-hidden rounded-xl border border-line bg-ink-950/70">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-200"><GitBranch size={14} className="text-accent" /> 调用关系</summary>
      <div className="space-y-3 border-t border-line p-4 text-xs text-zinc-400">
        <p className="leading-relaxed">{report.call_relationships.summary}</p>
        {report.call_relationships.agents.map((agent) => <div key={agent.trajectory_id} className="rounded-lg border border-ink-800 bg-ink-900/55 p-3">
          <div className="font-medium text-zinc-200">{agent.role} <code className="ml-1 text-[10px] text-zinc-600">{agent.trajectory_id}</code></div>
          <p className="mt-1">{agent.work_summary || agent.assignment}</p>{agent.result_summary && <p className="mt-1 text-zinc-500">交付：{agent.result_summary}</p>}
        </div>)}
        {report.call_relationships.edges.map((edge, index) => <div key={`${edge.parent_trajectory_id}-${edge.child_trajectory_id}-${index}`} className="rounded-lg border border-violet-500/15 bg-violet-500/[0.025] p-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px]"><code>{edge.parent_trajectory_id}</code><ArrowRight size={11} className="text-violet-300" /><code>{edge.child_trajectory_id}</code>{edge.dispatch_turn_id && <Link to={href(edge.dispatch_turn_id)} className="text-sky-300 hover:text-sky-200">派发 Turn</Link>}</div>
          {edge.request && <p className="mt-2"><span className="text-zinc-600">任务：</span>{edge.request}</p>}
          {edge.result && <p className="mt-1"><span className="text-zinc-600">返回：</span>{edge.result}</p>}
          {edge.usage && <p className="mt-1"><span className="text-zinc-600">使用：</span>{edge.usage}</p>}
        </div>)}
      </div>
    </details>

    <section>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500"><Activity size={14} /> 执行过程</h3>
      <div className="mt-2 space-y-2">{report.execution_phases.map((phase, index) => <div key={`${phase.title}-${index}`} className="rounded-xl border border-line bg-ink-950/70 p-3.5">
        <div className="flex items-start gap-3"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-accent/10 text-[10px] font-semibold text-accent">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium text-zinc-100">{phase.title}</h4><span className="text-[10px] uppercase text-zinc-600">{phase.status}</span></div><p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{phase.summary}</p><p className="mt-1 text-xs text-zinc-500">结果：{phase.result}</p>{!!phase.turn_ids.length && <div className="mt-2 flex flex-wrap gap-1.5">{turnLinks(phase.turn_ids)}</div>}</div></div>
      </div>)}</div>
    </section>

    <details className="overflow-hidden rounded-xl border border-line bg-ink-950/70">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-200"><ListTree size={14} className="text-zinc-500" /> 单 Turn 描述<span className="ml-auto text-xs font-normal text-zinc-600">{report.turns.length} 个 Turn</span></summary>
      <div className="divide-y divide-ink-800 border-t border-line">{report.turns.map((turn) => <details key={turn.turn_id} className="px-4 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-zinc-400"><span className={`h-1.5 w-1.5 rounded-full ${assessmentColor[turn.assessment] ?? assessmentColor.unclear}`} /><span className="w-14 shrink-0 font-mono text-accent">Turn {turn.global_turn}</span><span className="min-w-0 flex-1 truncate">{turn.purpose}</span><span className="text-[10px] text-zinc-700">{clock(turn.at_ms)}</span></summary>
        <div className="space-y-1.5 pb-2 pl-5 pt-3 text-xs leading-relaxed text-zinc-400"><p><span className="text-zinc-600">目的：</span>{turn.purpose}</p><p><span className="text-zinc-600">动作：</span>{turn.action}</p><p><span className="text-zinc-600">结果：</span>{turn.result}</p><p><span className="text-zinc-600">推进：</span>{turn.progress || '未说明'}</p><Link to={href(turn.turn_id)} className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200">查看原始 Turn <ArrowRight size={10} /></Link></div>
      </details>)}</div>
    </details>

    <details open className="overflow-hidden rounded-xl border border-line bg-ink-950/70">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-200"><Target size={14} className="text-violet-300" /> Evaluator 评分分析{report.evaluator_analysis.score != null && <span className="ml-auto font-mono text-xs text-violet-300">{fmtScore(report.evaluator_analysis.score)}</span>}</summary>
      <div className="space-y-3 border-t border-line p-4 text-xs leading-relaxed text-zinc-400"><p>{report.evaluator_analysis.summary}</p>{report.evaluator_analysis.method && <p><span className="text-zinc-600">评分方法：</span>{report.evaluator_analysis.method}</p>}{report.evaluator_analysis.criteria.map((criterion, index) => <div key={`${criterion.criterion}-${index}`} className="rounded-lg border border-ink-800 bg-ink-900/55 p-3"><div className="font-medium text-zinc-200">{criterion.criterion}{criterion.score != null && <span className="ml-2 font-mono text-violet-300">{fmtScore(criterion.score)}</span>}</div><p className="mt-1 text-zinc-500">{criterion.result}</p>{!!criterion.related_turn_ids.length && <div className="mt-2 flex flex-wrap gap-1.5">{turnLinks(criterion.related_turn_ids)}</div>}</div>)}{report.evaluator_analysis.execution_discrepancy && <p className="border-t border-line pt-3"><span className="text-zinc-600">与执行过程的关系：</span>{report.evaluator_analysis.execution_discrepancy}</p>}</div>
    </details>
  </div>
}

function NativeAnalysis({ report, batchId, taskKey }: {
  report: NativeReport; batchId: string; taskKey: string
}) {
  const href = (atMs?: number | null, turn?: number) => {
    const query = new URLSearchParams({ at_ms: String(atMs ?? 0) })
    if (turn != null) query.set('turn', String(turn))
    return `/live/runs/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskKey)}?${query}`
  }
  const severityStyle: Record<string, string> = {
    critical: 'border-rose-500/40 bg-rose-500/[0.035] text-rose-300',
    high: 'border-orange-500/35 bg-orange-500/[0.03] text-orange-300',
    medium: 'border-amber-500/30 bg-amber-500/[0.025] text-amber-300',
    low: 'border-ink-700 bg-ink-950 text-zinc-400',
  }
  const severityLabel: Record<string, string> = {
    critical: '严重', high: '高', medium: '中', low: '低',
  }
  const harnessLabel: Record<string, string> = {
    direct_fault: 'Harness 根因', contributing_factor: 'Harness 放大因素',
    missing_guardrail: '缺少防护机制', observability_gap: '可观测性缺口',
  }
  const harnessAssessed = report.issues.some((issue) => !!issue.harness_relationship)
  const harnessIssues = harnessAssessed
    ? report.issues.filter((issue) => issue.harness_relationship !== 'no_supported_harness_finding')
    : report.issues
  const otherIssues = harnessAssessed
    ? report.issues.filter((issue) => issue.harness_relationship === 'no_supported_harness_finding')
    : []
  const agentById = new Map(report.trace.agents.map((agent) => [agent.trajectory_id, agent]))
  const dispatchEdges = report.trace.call_edges ?? []
  return <div className="space-y-5">
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-ink-900/70 sm:grid-cols-4">
      {[
        ['得分', fmtScore(report.metrics?.score)], ['Harness 可修复点', harnessIssues.length],
        ['Turn', report.trace.turn_count], ['Agent', report.trace.agent_count],
      ].map(([label, value], index) => <div key={String(label)} className={clsx('px-3 py-3', index < 3 && 'border-r border-line')}>
        <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
        <div className="mt-0.5 text-lg font-semibold tabular-nums text-white">{value}</div>
      </div>)}
    </div>
    <section className="relative overflow-hidden rounded-xl border border-accent/25 bg-accent/[0.045] p-4 pl-5">
      <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-accent"><Sparkles size={12} /> 核心结论</div>
      <p className="mt-2 text-sm font-medium leading-relaxed text-zinc-200">{report.executive_summary}</p>
      <p className="mt-3 border-t border-accent/10 pt-3 text-xs leading-relaxed text-zinc-500">{report.score_analysis}</p>
    </section>
    {report.analysis_input_quality && <section className={clsx('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs', report.analysis_input_quality.limits_mapping_confidence ? 'border-amber-500/25 bg-amber-500/[0.06]' : 'border-emerald-500/20 bg-emerald-500/[0.045]')}>
      {report.analysis_input_quality.limits_mapping_confidence ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-400" />}
      <div><span className="font-medium text-zinc-300">轨迹覆盖率 {Math.round(report.analysis_input_quality.trace_coverage * 100)}%</span>
        <span className="ml-2 text-zinc-500">{report.analysis_input_quality.provenance_complete ? '来源信息完整' : `缺失：${report.analysis_input_quality.missing_event_types.join(', ')}`}</span>
        {report.analysis_input_quality.limits_mapping_confidence && <p className="mt-1 text-zinc-500">缺失事件会限制归因置信度，但不会被计为 Agent 失败。</p>}
      </div>
    </section>}
    {report.evaluator_source && <section className="rounded-lg border border-violet-500/20 bg-violet-500/[0.035] px-3 py-2.5 text-xs text-zinc-400">
      <span className="font-medium text-violet-300">Evaluator 特权审计上下文：</span>{report.evaluator_source.available
        ? <>已加载 <code className="text-zinc-300">{report.evaluator_source.task_path}</code>{report.evaluator_source.repository_revision && <> · revision <code>{report.evaluator_source.repository_revision.slice(0, 10)}</code></>}</>
        : <>未加载（{report.evaluator_source.reason || '未配置'}）</>}
      <p className="mt-1 text-[11px] text-zinc-600">仅供 episode 后 AFT 解释评分；执行 Agent 不可见，也不得据此生成针对隐藏评分实现的优化建议。</p>
    </section>}
    {report.analysis_workflow?.mode === 'agentic-tool-loop' && <section className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.035] px-3 py-2.5 text-xs text-zinc-400">
      <span className="font-medium text-cyan-300">Agentic 取证流程：</span>Analyzer 在同一个持续 Turn 中主动调用了 {report.analysis_workflow.tool_call_count} 次只读工具。
      <p className="mt-1 text-[11px] text-zinc-600">完整取证包与 taxonomy 由 Analyzer 在 Turn 中主动读取，不会预先塞入初始 prompt；服务端会拒绝缺少角色覆盖或 Turn 证据的空报告。</p>
    </section>}
    {!!report.score_breakdown?.length && <section>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500"><Activity size={14} /> 评分分解</h3>
        <span className="text-xs text-zinc-600">Evaluator × Instruction × Trajectory</span>
      </div>
      <div className="mt-2 space-y-2">{report.score_breakdown.map((item, index) => <div key={`${item.criterion}-${index}`} className="rounded-lg border border-ink-800 bg-ink-950/70 p-3 text-xs">
        <div className="flex items-start gap-3"><span className="min-w-16 font-mono text-accent">{item.awarded_score}/{item.maximum_score}</span><div><div className="font-medium text-zinc-200">{item.criterion}</div><p className="mt-1 text-zinc-500">{item.loss_reason}</p><code className="mt-1 block text-[10px] text-zinc-700">{item.evaluator_basis}</code></div></div>
      </div>)}</div>
    </section>}
    {!harnessAssessed && <section className="flex items-start gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-xs text-zinc-400">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
      <div><span className="font-medium text-amber-200">这是旧版 model-centric 报告</span><p className="mt-1 text-zinc-500">它没有单独评估 harness 根因、放大因素、防护缺口和可观测性缺口；请点“重新分析”生成 harness-first 报告。</p></div>
    </section>}
    <section>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500"><Target size={14} /> Harness 可修复问题</h3>
        <span className="text-xs tabular-nums text-zinc-600">{harnessIssues.length}</span>
      </div>
      <div className="mt-2 space-y-2">
        {harnessIssues.map((issue, issueIndex) => <details key={issue.issue_id} open={issueIndex === 0}
          className={clsx('group overflow-hidden rounded-xl border', severityStyle[issue.severity] ?? severityStyle.low)}>
          <summary className="flex cursor-pointer list-none items-start gap-3 p-3.5">
            <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-ink-900 text-[10px] font-semibold tabular-nums">{issueIndex + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-snug text-zinc-100">{issue.harness_finding || issue.summary}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                {issue.harness_relationship && <><span className="text-emerald-400">{harnessLabel[issue.harness_relationship] ?? issue.harness_relationship}</span><span>·</span></>}
                {issue.harness_layer && <><code className="text-violet-300">{issue.harness_layer}</code><span>·</span></>}
                <code className="text-accent">{issue.tag_mapping?.primary_tag || 'unmapped'}</code>
                <span>·</span><span>{issue.responsibility}</span><span>·</span>
                <span>置信度 {Math.round(issue.confidence * 100)}%</span>
                <span>·</span><span>{issue.evidence?.length ?? 0} 条证据</span>
              </div>
            </div>
            <span className="chip shrink-0 bg-ink-900">{severityLabel[issue.severity] ?? issue.severity}</span>
          </summary>
          <div className="border-t border-current/10 bg-ink-950/55 p-4">
            <dl className="space-y-3 text-xs leading-relaxed">
              {issue.harness_finding && <div className="grid grid-cols-[64px_1fr] gap-2"><dt className="text-zinc-600">触发表现</dt><dd className="text-zinc-300">{issue.summary}</dd></div>}
              <div className="grid grid-cols-[64px_1fr] gap-2"><dt className="text-zinc-600">期望行为</dt><dd className="text-zinc-300">{issue.expected_behavior}</dd></div>
              <div className="grid grid-cols-[64px_1fr] gap-2"><dt className="text-zinc-600">实际行为</dt><dd className="text-zinc-300">{issue.actual_behavior}</dd></div>
              <div className="grid grid-cols-[64px_1fr] gap-2"><dt className="text-zinc-600">影响</dt><dd className="text-zinc-300">{issue.impact}</dd></div>
              {issue.harness_recommendation && <div className="grid grid-cols-[64px_1fr] gap-2 rounded-lg border border-emerald-500/10 bg-emerald-500/[0.025] p-2"><dt className="text-emerald-500">Harness 改动</dt><dd className="text-zinc-300">{issue.harness_recommendation}</dd></div>}
            </dl>
            {!!issue.evidence?.length && <div className="mt-4 flex flex-wrap gap-1.5 border-t border-ink-800 pt-3">
              {uniqueSortedTurnEvidence(issue.evidence, report.turns).map(({ evidence: item, globalTurn }) => {
                return <Link key={globalTurn == null ? item.turn_id : `turn-${globalTurn}`} to={href(item.timestamp_ms, globalTurn)}
                title={item.excerpt} className="chip border border-sky-500/15 bg-sky-500/10 text-sky-300 hover:border-sky-400/40 hover:bg-sky-500/20">
                Turn {globalTurn ?? item.turn_id.split(':').slice(-1)[0]} · {clock(item.timestamp_ms)} <ArrowRight size={10} />
              </Link>})}
            </div>}
          </div>
        </details>)}
      </div>
    </section>
    {!!otherIssues.length && <details className="rounded-xl border border-line bg-ink-950/70">
      <summary className="cursor-pointer list-none px-4 py-3 text-xs text-zinc-500">Model / environment 表现（没有足够证据形成 Harness finding） · {otherIssues.length}</summary>
      <div className="space-y-2 border-t border-line p-4">{otherIssues.map((issue) => <div key={issue.issue_id} className="rounded-lg border border-ink-800 bg-ink-900/60 p-3"><div className="text-xs font-medium text-zinc-300">{issue.summary}</div><div className="mt-1 text-[11px] text-zinc-600">根因归属：{issue.responsibility} · {issue.tag_mapping?.primary_tag || 'unmapped'}</div></div>)}</div>
    </details>}
    <details open className="group overflow-hidden rounded-xl border border-line bg-ink-950/70">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-200">
        <GitBranch size={14} className="text-accent" /> Agent 调用图
        <span className="ml-auto text-xs font-normal text-zinc-600">{report.trace.agent_count} 个 Agent</span>
      </summary>
      <div className="space-y-3 border-t border-line p-4">
        {!!report.call_chain_analysis && <div className="rounded-lg border border-accent/15 bg-accent/[0.035] px-3 py-2.5 text-xs leading-relaxed text-zinc-300">
          {report.call_chain_analysis}
        </div>}
        <div className="space-y-1 rounded-lg border border-ink-800 bg-ink-950 p-2.5 font-mono text-[11px] text-zinc-400">
          {report.trace.agents.map((agent) => <div key={agent.trajectory_id} className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 hover:bg-ink-800/60" style={{ marginLeft: `${agent.depth * 14}px` }}>
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', agent.depth ? 'bg-violet-400' : 'bg-accent')} />
            <span className="font-sans font-medium uppercase tracking-wide text-zinc-200">{roleLabel(agent)}</span>
            {agent.responsibility_summary && <span className="truncate font-sans text-[10px] text-zinc-500">{agent.responsibility_summary}</span>}
            <span className="truncate text-zinc-700">{agent.trajectory_id}</span>
          </div>)}
        </div>
        {dispatchEdges.length ? <div className="space-y-2">
          {dispatchEdges.map((edge, index) => {
            const parent = agentById.get(edge.parent_trajectory_id)
            const child = agentById.get(edge.child_trajectory_id)
            const turn = edge.parent_turn == null ? undefined : report.turns.find((item) => item.global_turn === edge.parent_turn)
            return <div key={`${edge.parent_trajectory_id}-${edge.child_trajectory_id}-${index}`}
              className="grid items-center gap-2 rounded-lg border border-ink-800 bg-ink-900/55 px-3 py-2 text-xs sm:grid-cols-[1fr_auto_1fr]">
              <div className="min-w-0"><div className="truncate font-medium uppercase tracking-wide text-zinc-200">{roleLabel(parent)}</div><div className="truncate font-mono text-[10px] text-zinc-700">{edge.parent_trajectory_id}</div></div>
              {edge.parent_turn != null ? <Link to={href(turn?.at_ms, edge.parent_turn)}
                className="inline-flex items-center justify-center gap-1 rounded-md border border-sky-500/15 bg-sky-500/10 px-2 py-1 text-sky-300 hover:border-sky-400/40">
                Turn {edge.parent_turn} · {edge.tool_name || '派发'} <ArrowRight size={10} />
              </Link> : <span className="text-center text-zinc-600">派发 →</span>}
              <div className="min-w-0 sm:text-right"><div className="truncate font-medium uppercase tracking-wide text-violet-300">{roleLabel(child)}</div><div className="truncate text-[11px] text-zinc-400">{child?.responsibility_summary || child?.assignment || '未记录职责'}</div><div className="truncate font-mono text-[10px] text-zinc-700">{edge.child_trajectory_id}</div></div>
            </div>
          })}
        </div> : <p className="rounded-lg border border-dashed border-ink-700 px-3 py-3 text-center text-xs text-zinc-600">本次执行未发生子 Agent 派发。</p>}
      </div>
    </details>
    <details className="group overflow-hidden rounded-xl border border-line bg-ink-950/70">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-200">
        <ListTree size={14} className="text-zinc-500" /> 逐 Turn 分析
        <span className="ml-auto text-xs font-normal text-zinc-600">{report.turns.length} 个 Turn</span>
      </summary>
      <div className="divide-y divide-ink-800 border-t border-line">
        {report.turns.map((turn) => <details key={turn.turn_id} className="px-4 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-zinc-400">
            <span className={clsx('h-1.5 w-1.5 rounded-full', turn.assessment === 'problem' ? 'bg-rose-400' : turn.assessment === 'good' ? 'bg-emerald-400' : 'bg-zinc-600')} />
            <span className="w-14 shrink-0 font-mono text-accent">Turn {turn.global_turn}</span>
            <span className="min-w-0 flex-1 truncate">{turnSummary(turn)}</span>
            <span className="shrink-0 text-[10px] text-zinc-700">{clock(turn.at_ms)}</span>
          </summary>
          <div className="space-y-2 pb-2 pl-5 pt-3 text-xs leading-relaxed text-zinc-400">
            <p>{turnSummary(turn)}</p>
            {conciseChinese(turn.action) && <p><span className="text-zinc-600">操作：</span> {conciseChinese(turn.action)}</p>}
            {conciseChinese(turn.outcome) && <p><span className="text-zinc-600">结果：</span> {conciseChinese(turn.outcome)}</p>}
            <Link to={href(turn.at_ms, turn.global_turn)} className="inline-flex items-center gap-1 text-sky-300 hover:underline">在 Replay 中打开 <ArrowRight size={10} /></Link>
          </div>
        </details>)}
      </div>
    </details>
    {(!!report.strengths?.length || !!report.recommendations?.length) && <div className="grid gap-3 lg:grid-cols-2">
      {!!report.strengths?.length && <section className="rounded-xl border border-emerald-500/15 bg-emerald-500/[0.035] p-4"><h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400"><CheckCircle2 size={13} /> 做得好的地方</h3><ul className="mt-3 space-y-2 text-xs leading-relaxed text-zinc-400">{report.strengths.map((item) => <li key={item} className="flex gap-2"><span className="text-emerald-500">·</span>{item}</li>)}</ul></section>}
      {!!report.recommendations?.length && <section className="rounded-xl border border-accent/15 bg-accent/[0.035] p-4"><h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent"><Activity size={13} /> 改进建议</h3><ul className="mt-3 space-y-2 text-xs leading-relaxed text-zinc-400">{report.recommendations.map((item) => <li key={item} className="flex gap-2"><span className="text-accent">·</span>{item}</li>)}</ul></section>}
    </div>}
  </div>
}

export default function BackendExecutionAnalysis({ batchId, taskKey }: {
  batchId: string; taskKey: string
}) {
  const [state, setState] = useState<ExecutionAnalysisState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [revision, setRevision] = useState(0)
  const [models, setModels] = useState<AnalysisModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    fetchExecutionAnalysis(batchId, taskKey, controller.signal).then((next) => {
      if (controller.signal.aborted) return
      setState(next)
      setError(null)
      if (isActiveJob(next.job)) {
        timer = setTimeout(() => setRevision((value) => value + 1), 3000)
      }
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(String(reason))
    })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [batchId, taskKey, revision])

  useEffect(() => {
    const controller = new AbortController()
    fetchAnalysisModels(controller.signal).then(({ models: next }) => {
      if (controller.signal.aborted) return
      // Which models the product offers is the backend's policy, published per entry.
      const visible = next.filter((item) => !item.hidden)
      setModels(visible)
      setSelectedModel((current) => visible.some((item) => item.model === current)
        ? current : visible.find((item) => item.isDefault)?.model || visible[0]?.model || '')
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(String(reason))
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const analyzedWith = reportModel(state?.report ?? null)
    if (analyzedWith && models.some((item) => item.model === analyzedWith)) {
      setSelectedModel(analyzedWith)
    }
  }, [state?.report?.model, models])

  const content = useMemo(
    () => evidenceLinks(reportContent(state?.report ?? null), batchId, taskKey),
    [state?.report, batchId, taskKey],
  )
  const executionReport = taskExecutionReport(state?.report?.payload)
  const structured = nativeReport(state?.report?.payload)
  const job = state?.job
  const report = state?.report ?? null
  const jobActive = isActiveJob(job)
  const jobFailed = isTerminalJob(job) && !!job && ['failed', 'cancelled'].includes(job.status)
  const reportStale = isStaleReport(report)
  const progress = job?.progress?.task_reports
  const progressPercent = job?.progress?.percent
  const phaseLabel = jobPhaseLabel(job, '排队中')

  const start = async (force = false) => {
    setStarting(true)
    setError(null)
    try {
      setState(await startExecutionAnalysis(batchId, taskKey, selectedModel || undefined, undefined, force))
      setRevision((value) => value + 1)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setStarting(false)
    }
  }

  if (content || structured || executionReport) {
    const evidence = state?.report?.evidence ?? state?.report?.payload?.evidence ?? []
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-ink-900/70 p-2 text-[11px] text-zinc-600">
          {reportStale
            ? <span className="chip bg-amber-500/10 text-amber-300"><AlertTriangle size={11} />报告已过期</span>
            : <span className="chip bg-emerald-500/10 text-emerald-300"><CheckCircle2 size={11} />{jobActive ? '已有报告' : '分析完成'}</span>}
          {reportStale && <span className="text-zinc-500">当前 pipeline / taxonomy / evaluator 已变化，建议重新分析</span>}
          {jobActive && <span className="chip bg-accent/10 text-accent"><Activity size={11} className="animate-pulse" /> 正在更新</span>}
          {!jobActive && job?.status === 'completed' && <span className="chip bg-sky-500/10 text-sky-300">最近一次重新分析已完成</span>}
          {jobFailed && <span className="chip bg-rose-500/10 text-rose-300">重新分析失败</span>}
          {reportModel(report) && <span className="text-zinc-400">{reportModel(report)}</span>}
          {report?.revision && <span>r{report.revision}</span>}
          {!!evidence.length && <span>{evidence.length} 条证据</span>}
          {state?.oss_status && <span>OSS {state.oss_status}</span>}
          <select aria-label="AFT 重新分析模型" className="input ml-auto max-w-56 py-1 text-xs"
            value={selectedModel} disabled={starting || jobActive}
            onChange={(event) => setSelectedModel(event.target.value)}>
            {models.map((item) => <option key={item.model} value={item.model}>{item.displayName}</option>)}
          </select>
          <button className="btn-secondary py-1 text-xs" disabled={starting || jobActive || !selectedModel}
            onClick={() => void start(reportStale || jobFailed)}><RotateCcw size={11} />{starting ? '正在启动…' : '重新分析'}</button>
        </div>
        {jobActive && <div className="space-y-3 rounded-xl border border-accent/20 bg-accent/[0.035] p-4">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 font-medium text-accent"><Activity size={12} className="animate-pulse" />{phaseLabel}</span>
            {progressPercent != null ? <span className="tabular-nums text-zinc-500">{progressPercent}%</span> : job?.progress?.evidence_requests ? (
              <span className="text-zinc-500">{job.progress.evidence_requests} 次取证调用</span>
            ) : progress?.total ? <span className="text-zinc-500">{progress.completed ?? 0}/{progress.total} 份 Task 报告</span> : null}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-accent transition-all" style={{
              width: `${progressPercent != null ? progressPercent
                : progress?.total ? Math.max(3, ((progress.completed ?? 0) / progress.total) * 100) : 8}%`,
            }} />
          </div>
          <p className="text-[11px] text-zinc-600">新版报告生成期间，旧报告暂时保留在下方。</p>
        </div>}
        {jobFailed && <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-200">
          重新分析未完成：{job?.error?.message || job?.status}。旧报告仍保留在下方。
        </p>}
        {executionReport
          ? <TaskExecutionAnalysis report={executionReport} batchId={batchId} taskKey={taskKey} />
          : structured ? <NativeAnalysis report={structured} batchId={batchId} taskKey={taskKey} /> : <Markdown content={content} />}
      </div>
    )
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="relative overflow-hidden rounded-xl border border-accent/20 bg-accent/[0.035] p-4 pl-5 text-zinc-400">
        <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-100"><Sparkles size={14} className="text-accent" /> 分析此 Execution</div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          Analyzer 可自主读取任务上下文、ATIF 轨迹、具体 Turn、Agent 调用关系、Evaluator 和执行产物，生成以实际执行过程为主体的单任务报告。
        </p>
      </div>
      {jobActive ? (
        <div className="space-y-3 rounded-xl border border-line bg-ink-950/70 p-4">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 font-medium text-accent"><Activity size={12} className="animate-pulse" />{phaseLabel}</span>
            {progressPercent != null ? <span className="tabular-nums text-zinc-500">{progressPercent}%</span> : job?.progress?.evidence_requests ? (
              <span className="text-zinc-500">{job.progress.evidence_requests} 次取证调用</span>
            ) : progress?.total ? <span className="text-zinc-500">{progress.completed ?? 0}/{progress.total} 份 Task 报告</span> : null}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-accent transition-all" style={{
              width: `${progressPercent != null ? progressPercent
                : progress?.total ? Math.max(3, ((progress.completed ?? 0) / progress.total) * 100) : 8}%`,
            }} />
          </div>
          <p className="text-[11px] text-zinc-600">更新期间仍可阅读已有报告。</p>
        </div>
      ) : (
        (!job || jobFailed) && <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-ink-950/60 p-4">
          <label className="min-w-64 flex-1 text-xs text-zinc-400">
            <span className="mb-1 block">AFT 分析模型</span>
            <select
              aria-label="AFT 分析模型"
              className="input w-full"
              value={selectedModel}
              disabled={starting || models.length === 0}
              onChange={(event) => setSelectedModel(event.target.value)}
            >
              {models.length === 0 && <option value="">正在加载模型…</option>}
              {models.map((item) => (
                <option key={item.model} value={item.model}>
                  {item.displayName}{item.isDefault ? '（默认）' : ''}
                </option>
              ))}
            </select>
            {selectedModel && <span className="mt-1 block text-zinc-600">
              {models.find((item) => item.model === selectedModel)?.description}
            </span>}
          </label>
          <button className="btn-primary" disabled={starting || !selectedModel} onClick={() => void start(jobFailed)}>
            {jobFailed ? <RotateCcw size={13} /> : <Sparkles size={13} />}{starting ? '正在启动分析…' : jobFailed ? '重新分析' : '分析 Execution'}
          </button>
        </div>
      )}
      {job && isTerminalJob(job) && !content && (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-300">
          分析以 {job.status} 结束，尚未生成可复用报告。{job.error?.message && <> 原因：{job.error.message}。</>} 可在上方更换模型后重新分析。
        </p>
      )}
      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</p>}
    </div>
  )
}

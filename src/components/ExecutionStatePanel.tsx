import { memo, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { PlannerNodeV1, PlannerStateV1 } from '../lib/osworldAtifExtra'
import type { ExecutionStateEvent, ExecutionStateFeed } from '../lib/ossReplay'

const PAGE_SIZE = 40

function clock(ms: number): string {
  const safe = Math.max(0, ms)
  return `${String(Math.floor(safe / 60_000)).padStart(2, '0')}:${String(Math.floor(safe % 60_000 / 1000)).padStart(2, '0')}`
}

function agentLabel(agent: PlannerNodeV1['agent']): string {
  return agent.replace('stateact_', '')
}

function PlanNode({ node, status }: {
  node: PlannerNodeV1 & { outcome?: 'completed' | 'failed' }
  status: 'completed' | 'failed' | 'next' | 'pending'
}) {
  const appearance = {
    completed: { icon: '✓', label: 'Completed', border: 'border-emerald-500/30', iconClass: 'bg-emerald-500/15 text-emerald-300' },
    failed: { icon: '×', label: 'Failed', border: 'border-rose-500/35', iconClass: 'bg-rose-500/15 text-rose-300' },
    next: { icon: '▶', label: 'Next', border: 'border-sky-400/50', iconClass: 'bg-sky-400/15 text-sky-300' },
    pending: { icon: '·', label: 'Pending', border: 'border-ink-700', iconClass: 'bg-zinc-700/40 text-zinc-400' },
  }[status]
  return (
    <li className={clsx('rounded-lg border bg-ink-950/40 p-2.5', appearance.border)} data-plan-node={node.id} data-plan-status={status}>
      <div className="flex gap-2.5">
        <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', appearance.iconClass)} aria-label={appearance.label}>{appearance.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="font-mono text-zinc-500">{node.id}</span>
            <span className="rounded bg-violet-400/10 px-1.5 py-0.5 font-semibold text-violet-300">{agentLabel(node.agent)}</span>
            <span className="text-zinc-600">≤ {node.max_turns} turns</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-zinc-200">{node.task}</p>
        </div>
      </div>
    </li>
  )
}

function PlannerCard({ event, onJump }: {
  event: ExecutionStateEvent
  onJump: (atMs: number) => void
}) {
  const state = event.record as unknown as PlannerStateV1
  const { plan, budget } = state
  const total = plan.completed.length + plan.remaining.length
  const percent = budget.maxTurns == null || budget.maxTurns === 0
    ? null : Math.min(100, Math.round(budget.usedTurns / budget.maxTurns * 100))
  const cause = state.cause === 'plan_updated' ? 'Plan updated'
    : state.cause === 'executor_returned' ? 'Executor returned' : 'Task returned'
  return (
    <div className="rounded-xl border border-sky-400/40 bg-gradient-to-b from-sky-400/[0.07] to-ink-900/50 p-3" data-planner-state>
      <div className="flex items-start gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">Plan v{plan.version}</h3>
            <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[10px] font-medium text-sky-300">{cause}</span>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">{plan.completed.length}/{total} nodes finished</p>
        </div>
        <button onClick={() => onJump(event.episode_elapsed_ms)} className="ml-auto font-mono text-[10px] text-sky-300 hover:text-sky-200" title="Move Desktop and Steps to this Planner update">{clock(event.episode_elapsed_ms)} ↗</button>
      </div>

      <div className="mt-3 rounded-lg bg-ink-950/50 p-2.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="font-medium uppercase tracking-wide text-zinc-500">Global turn budget</span>
          <span className="font-mono text-zinc-300">
            {budget.maxTurns == null ? `${budget.usedTurns} used · unbounded` : `${budget.usedTurns} / ${budget.maxTurns} · ${budget.remainingTurns} left`}
          </span>
        </div>
        {percent != null && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700" aria-label={`${percent}% of global turn budget used`}>
          <div className={clsx('h-full rounded-full', percent >= 90 ? 'bg-rose-400' : percent >= 70 ? 'bg-amber-400' : 'bg-sky-400')} style={{ width: `${percent}%` }} />
        </div>}
      </div>

      {total ? <ol className="mt-3 space-y-2" aria-label="Planner nodes">
        {plan.completed.map(node => <PlanNode key={node.id} node={node} status={node.outcome} />)}
        {plan.remaining.map(node => <PlanNode key={node.id} node={node} status={node.id === plan.next?.id ? 'next' : 'pending'} />)}
      </ol> : <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-2.5 text-xs text-emerald-300">No remaining plan nodes.</p>}
    </div>
  )
}

function ExecutionStatePanel({ feed, playheadMs, onJump }: {
  feed: ExecutionStateFeed
  playheadMs: number
  onJump: (atMs: number) => void
}) {
  const [page, setPage] = useState(0)
  const planEvents = useMemo(() => feed.events.filter(event => event.event === 'planner_state')
    .sort((a, b) => a.episode_elapsed_ms - b.episode_elapsed_ms || a.sequence - b.sequence), [feed.events])
  const observerEvents = useMemo(() => feed.events.filter(event => event.event === 'observer_interval')
    .sort((a, b) => Number(a.record?.interval_id) - Number(b.record?.interval_id)), [feed.events])
  const pageCount = Math.max(1, Math.ceil(observerEvents.length / PAGE_SIZE))
  const activePage = Math.min(page, pageCount - 1)
  const pastPlans = planEvents.filter(event => event.episode_elapsed_ms <= playheadMs)
  const currentPlan = pastPlans[pastPlans.length - 1]
  const pastObservers = observerEvents.filter(event => event.episode_elapsed_ms <= playheadMs)
  const currentObserver = pastObservers[pastObservers.length - 1]
  return (
    <section className="space-y-4" aria-label="Execution State">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">Execution State</h2>
        <p className="mt-1 text-xs text-zinc-500">Planner · {planEvents.length} updates · Observer · {observerEvents.length} intervals</p>
      </div>

      {!!planEvents.length && <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Planner at playhead</h3>
          {!currentPlan && <span className="text-[10px] text-zinc-600">Not initialized yet</span>}
        </div>
        {currentPlan && <PlannerCard event={currentPlan} onJump={onJump} />}
      </div>}

      {!!observerEvents.length && <div className="border-t border-ink-700 pt-4">
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Observer history</h3>
        <div className="space-y-3">
          {observerEvents.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE).map(event => {
            const record = event.record ?? {}
            const failed = record.status === 'failed'
            return (
              <article key={event.sequence} className={clsx('rounded-lg border bg-ink-900/50 p-3', currentObserver === event ? 'border-amber-400/60' : 'border-ink-700')}>
                <div className="mb-2 flex items-center gap-2 text-[10px] text-zinc-500">
                  <span className="font-semibold text-sky-300">Observer</span>
                  <span>Interval {String(record.interval_id)} · {String(record.model_turns ?? 0)} turns</span>
                  <button onClick={() => onJump(event.episode_elapsed_ms)} className="ml-auto font-mono text-sky-300 hover:text-sky-200" title="Move Desktop and Steps to this event">{clock(event.episode_elapsed_ms)} ↗</button>
                </div>
                <p className={clsx('whitespace-pre-wrap text-sm leading-relaxed', failed ? 'text-amber-300' : 'text-zinc-200')}>
                  {failed ? `Observer unavailable: ${String(record.error ?? 'No description returned')}` : String(record.description ?? '')}
                </p>
              </article>
            )
          })}
        </div>
      </div>}

      {!planEvents.length && !observerEvents.length && <p className="text-sm text-zinc-500">{feed.terminal ? 'No Planner or Observer state recorded.' : 'Waiting for Planner state…'}</p>}
      {pageCount > 1 && <div className="flex items-center justify-between text-xs text-zinc-500">
        <button disabled={activePage === 0} onClick={() => setPage(activePage - 1)} className="btn-ghost disabled:opacity-30">← Previous</button>
        <span>{activePage + 1} / {pageCount}</span>
        <button disabled={activePage === pageCount - 1} onClick={() => setPage(activePage + 1)} className="btn-ghost disabled:opacity-30">Next →</button>
      </div>}
    </section>
  )
}

export default memo(ExecutionStatePanel)

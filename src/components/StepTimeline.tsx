import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, GitBranch, PanelLeftClose } from 'lucide-react'
import { ROLE_STYLES } from '../lib/format'
import { buildStepTree, stepTitle, type AgentStepGroup } from '../lib/stepTree'
import type { HumanLabel, Step } from '../lib/types'

const GLYPHS: Record<string, string> = { user: '👤', system: '⚙', agent: '✦', assistant: '✦', tool: '↩' }

interface Props {
  steps: Step[]
  activeStep: number
  labels: HumanLabel[]
  aftSteps: Set<number>
  onSelect: (index: number) => void
  onCollapse: () => void
}

export default function StepTimeline({ steps, activeStep, labels, aftSteps, onSelect, onCollapse }: Props) {
  const [mode, setMode] = useState<'agents' | 'time'>('agents')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const roots = useMemo(() => buildStepTree(steps), [steps])
  const groups = useMemo(() => {
    const all = new Map<string, AgentStepGroup>()
    const visit = (group: AgentStepGroup) => { all.set(group.agent.id, group); group.children.forEach(visit) }
    roots.forEach(visit)
    return all
  }, [roots])
  const labelByStep = useMemo(() => new Map(labels.map((label) => [label.stepIndex, label])), [labels])
  const currentAgent = steps[activeStep]?.agent?.id
  const hasAgents = steps.some((step) => step.agent)
  const lastReveal = useRef('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Keep manual folds across live polls; only reveal on an actual selection
    // change (including playback, State/AFT links, and chronological selection).
    const key = `${mode}:${currentAgent}:${activeStep}`
    if (lastReveal.current === key) return
    lastReveal.current = key
    if (mode !== 'agents' || !currentAgent) return
    // Child headers remain visible under folded parents, so revealing the
    // selected agent does not need to expand any ancestor's own steps.
    setCollapsed((previous) => new Set([...previous].filter((id) => id !== currentAgent)))
  }, [activeStep, currentAgent, groups, mode])

  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!list || !selected || !list.clientHeight) return
    // Scroll only the steps, never the toolbar or an ancestor/page container.
    const viewport = list.getBoundingClientRect()
    const row = selected.getBoundingClientRect()
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom
  }, [activeStep, collapsed, mode])

  function toggle(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function row(step: Step, showAgent = false) {
    const label = labelByStep.get(step.index)
    return (
      <li key={`step-${step.index}`}>
        <button
          type="button"
          data-step-index={step.index}
          aria-current={step.index === activeStep ? 'step' : undefined}
          onClick={() => onSelect(step.index)}
          className={clsx('flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors',
            step.index === activeStep ? 'bg-ink-800 ring-1 ring-accent/40' : 'hover:bg-ink-800/50')}
        >
          <span className={clsx('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-[11px]', ROLE_STYLES[step.role] ?? 'bg-ink-700')}>
            {GLYPHS[step.role] ?? '•'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
              <span>#{step.index + 1}</span>
              <span>{step.role}</span>
              {step.turn != null && <span>turn {step.turn}</span>}
              {step.edits?.length ? <span className="chip bg-emerald-500/15 text-emerald-300" title="environment change">▦</span>
                : step.toolCalls?.length ? <span className="chip bg-violet-500/15 text-violet-300">tool</span> : null}
              {!!step.mutations?.length && <span className="chip bg-accent/15 text-accent" title="artifact changes">±{step.mutations.length}</span>}
              {!!step.images?.length && <span className="chip bg-sky-500/15 text-sky-300">img {step.images.length}</span>}
              {aftSteps.has(step.index) && <span className="chip bg-rose-500/20 text-rose-300" title="AFT-flagged failure step">AFT</span>}
              {label && <span title={label.decision} className={clsx('h-2 w-2 rounded-full', {
                'bg-emerald-400': label.decision === 'correct', 'bg-rose-400': label.decision === 'incorrect',
                'bg-amber-400': label.decision === 'unsure',
              })} />}
            </span>
            {showAgent && step.agent && <span className="block truncate text-[11px] text-sky-300">{step.agent.label}</span>}
            <span className="block truncate text-zinc-200" title={stepTitle(step)}>{stepTitle(step)}</span>
          </span>
        </button>
      </li>
    )
  }

  function branch(group: AgentStepGroup, depth = 0): React.ReactNode {
    const { agent } = group
    const folded = collapsed.has(agent.id)
    const active = group.steps.some((step) => step.index === activeStep)
    // Folding hides only this agent's steps, never its delegation hierarchy.
    const items = [
      ...(folded ? [] : group.steps.map((step) => ({ index: step.index, child: false, node: row(step) }))),
      ...group.children.map((child) => ({
        index: child.agent.delegationStepIndex ?? child.steps[0]?.index ?? Infinity,
        child: true, node: branch(child, depth + 1),
      })),
    ].sort((a, b) => a.index - b.index || Number(a.child) - Number(b.child))
    return (
      <li key={`agent-${agent.id}`} data-agent-id={agent.id}>
        <div className="my-1 rounded-lg border border-ink-700 bg-ink-900/60">
          <button
            type="button" aria-expanded={!folded}
            aria-label={`${folded ? 'Expand' : 'Collapse'} agent ${agent.label}`}
            onClick={() => toggle(agent.id)}
            title={`${agent.role ?? agent.label} · ${agent.id}`}
            className="flex w-full items-center gap-1.5 px-2 py-2 text-left text-xs hover:bg-ink-800/50"
          >
            <ChevronRight size={14} className={clsx('shrink-0 transition-transform', !folded && 'rotate-90')} />
            <GitBranch size={13} className="shrink-0 text-sky-400" />
            <span className="min-w-0 flex-1 break-words font-medium text-zinc-200 [overflow-wrap:anywhere]">{agent.label}</span>
            {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Current agent" />}
            <span className="shrink-0 rounded bg-ink-800 px-1.5 text-zinc-400" title={`${group.totalSteps} steps`} aria-label={`${group.totalSteps} steps`}>{group.totalSteps}</span>
          </button>
          {agent.parentId && (
            <div className="px-3 pb-2 text-[11px] text-zinc-500">
              <span>from {agent.parentLabel ?? groups.get(agent.parentId)?.agent.label ?? 'parent'}</span>
              {agent.delegationStepIndex != null && (
                <button type="button" onClick={() => onSelect(agent.delegationStepIndex!)}
                  className="ml-1 text-sky-300 hover:underline" title={agent.delegationTool ?? 'Jump to delegation'}>
                  · step #{agent.delegationStepIndex + 1}
                </button>
              )}
            </div>
          )}
        </div>
        {items.length > 0 && <ol className={clsx('space-y-1 border-l border-ink-700', depth < 3 ? 'ml-2 pl-2' : 'pl-1')}>{items.map((item) => item.node)}</ol>}
      </li>
    )
  }

  return (
    <div data-tour="timeline" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div data-steps-toolbar className="shrink-0 border-b border-ink-700 px-3 pb-1 pt-3">
        <div className="mb-2 flex items-center justify-between gap-1 text-xs text-zinc-500">
          <span>{steps.length} steps{hasAgents ? ` · ${groups.size} agents` : ''}</span>
          <button type="button" onClick={onCollapse} aria-label="Hide steps panel" title="Hide steps panel" className="rounded p-1 hover:bg-ink-800 hover:text-zinc-200">
            <PanelLeftClose size={15} />
          </button>
        </div>
        {hasAgents && <>
          <div className="mb-2 flex gap-1 rounded-lg bg-ink-900 p-1" role="group" aria-label="Step grouping">
            {(['agents', 'time'] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value}
              onClick={() => setMode(value)} className={clsx('min-w-0 flex-1 rounded px-1 py-1.5 text-xs', mode === value ? 'bg-ink-700 text-white' : 'text-zinc-500 hover:text-zinc-200')}>
              {value === 'agents' ? 'By agent' : 'Chronological'}
            </button>)}
          </div>
          {mode === 'agents' && <div className="mb-2 flex justify-end gap-3 text-[11px] text-zinc-500">
            <button type="button" onClick={() => setCollapsed(new Set())} className="hover:text-zinc-200">Expand all</button>
            <button type="button" onClick={() => setCollapsed(new Set(groups.keys()))} className="hover:text-zinc-200">Collapse all</button>
          </div>}
        </>}
      </div>
      <div ref={listRef} data-steps-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 pt-2">
        <ol className="space-y-1" aria-label={hasAgents && mode === 'agents' ? 'Agent delegation tree' : 'Chronological steps'}>
          {hasAgents && mode === 'agents' ? roots.map((group) => branch(group)) : steps.map((step) => row(step, true))}
        </ol>
      </div>
    </div>
  )
}

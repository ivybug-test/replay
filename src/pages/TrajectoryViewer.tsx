import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { Loading, Pill, StatCell, StatusBadge } from '../components/ui'
import GradePanel from '../components/GradePanel'
import Markdown from '../components/Markdown'
import EnvironmentStage from '../components/EnvironmentStage'
import ExecutionStatePanel from '../components/ExecutionStatePanel'
import CodeBlock from '../components/CodeBlock'
import { ArcGridView, tryParseArcGrids } from '../components/ArcGrid'
import AftPanel from '../components/AftPanel'
import type { AftReport } from '../lib/aft'
import { FORMAT_LABELS, ROLE_STYLES, fmtDuration, fmtReward, fmtTokens, prettyModel } from '../lib/format'
import { useDatasetStore, useLookups, useRunSteps } from '../lib/dataset'
import type { DesktopFrame, ExecutionStateFeed } from '../lib/ossReplay'
import type { Agent, HumanLabel, LabelDecision, Mutation, Run, Step, StepImage, Task, Vendor } from '../lib/types'

const MUT_STYLES: Record<Mutation['kind'], string> = {
  file: 'bg-sky-500/15 text-sky-300',
  spreadsheet: 'bg-emerald-500/15 text-emerald-300',
  document: 'bg-violet-500/15 text-violet-300',
  git: 'bg-amber-500/15 text-amber-300',
  command: 'bg-zinc-500/15 text-zinc-300',
  answer: 'bg-rose-500/15 text-rose-300',
  other: 'bg-zinc-500/15 text-zinc-300',
}

/** Run-wide artifact-change view: every state-changing step, grouped & jumpable. */
function RunArtifacts({
  run,
  activeStep,
  onJump,
}: {
  run: Run
  activeStep: number
  onJump: (i: number) => void
}) {
  const changeSteps = run.steps.filter((s) => s.mutations && s.mutations.length > 0)
  const total = changeSteps.reduce((n, s) => n + (s.mutations?.length ?? 0), 0)

  if (changeSteps.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-ink-700 px-3 py-6 text-center text-sm text-zinc-600">
        This run made no detected artifact changes (no file/sheet/doc/git/answer writes).
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ink-700 bg-ink-950 p-3 text-sm text-zinc-400">
        <span className="text-zinc-200">{total}</span> change{total !== 1 ? 's' : ''} across{' '}
        <span className="text-zinc-200">{changeSteps.length}</span> step{changeSteps.length !== 1 ? 's' : ''}.
      </div>

      {run.artifacts && run.artifacts.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Artifacts touched</div>
          <div className="space-y-1">
            {run.artifacts.map((a) => (
              <code key={a} className="block truncate rounded bg-ink-800 px-2 py-1 font-mono text-[11px] text-zinc-300">
                {a}
              </code>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Change timeline</div>
        <div className="space-y-3">
          {changeSteps.map((s) => (
            <div key={s.index}>
              <button
                onClick={() => onJump(s.index)}
                className={clsx(
                  'mb-1.5 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
                  s.index === activeStep ? 'text-accent' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                <span className="font-medium">step {s.index + 1}</span>
                <span className="h-px flex-1 bg-ink-700" />
                <span>{s.mutations!.length} change{s.mutations!.length !== 1 ? 's' : ''}</span>
              </button>
              <MutationList mutations={s.mutations!} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MutationList({ mutations }: { mutations: Mutation[] }) {
  return (
    <div className="space-y-2">
      {mutations.map((m, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-ink-700">
          <div className="flex items-center gap-2 bg-ink-800 px-3 py-2">
            <span className={clsx('chip capitalize', MUT_STYLES[m.kind])}>{m.kind}</span>
            <span className="truncate text-sm text-zinc-200">{m.summary}</span>
            <code className="ml-auto shrink-0 font-mono text-[11px] text-violet-300">{m.tool}</code>
          </div>
          {m.target && (
            <div className="border-t border-ink-800 px-3 py-1.5">
              <code className="font-mono text-[11px] text-zinc-500">{m.target}</code>
            </div>
          )}
          {m.detail && (
            <div className="max-h-72 overflow-auto border-t border-ink-800 bg-ink-950 px-3 py-2">
              {m.kind === 'answer' || m.kind === 'document' ? (
                <Markdown content={m.detail} />
              ) : (
                <pre className="whitespace-pre-wrap text-[12px] text-zinc-400">{m.detail}</pre>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

const ROLE_GLYPH: Record<string, string> = {
  user: '👤',
  agent: '✦',
  assistant: '✦',
  system: '⚙',
  tool: '↩',
}

const DECISION_STYLES: Record<LabelDecision, string> = {
  correct: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  incorrect: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
  unsure: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
}

function stepTitle(s: Step): string {
  if (s.toolCalls?.length) return s.toolCalls.map((t) => t.name).join(', ')
  if (s.role === 'tool') return `${s.toolName ?? 'tool'} result`
  if (s.text) return s.text.replace(/\s+/g, ' ').slice(0, 60)
  if (s.observation) return 'observation'
  return s.role
}

function stepAnchorMs(step: Step): number {
  return Math.max(0, (step.endSec ?? step.tSec ?? 0) * 1000)
}

function stepIndexAt(steps: Step[], atMs: number): number {
  let match = 0
  for (let index = 0; index < steps.length; index += 1) {
    if ((steps[index].tSec ?? 0) * 1000 > atMs) break
    match = index
  }
  return match
}

function causalDesktopFrame(frames: DesktopFrame[] | undefined, atMs: number): DesktopFrame | null {
  if (!frames?.length) return null
  let low = 0
  let high = frames.length - 1
  let match = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (frames[middle].atMs <= atMs) {
      match = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return match >= 0 ? frames[match] : null
}

interface TrajectoryViewerProps {
  taskOverride?: Task
  runOverride?: Run
  agentOverride?: Agent
  vendorOverride?: Vendor
  desktopTimeline?: DesktopFrame[]
  executionState?: ExecutionStateFeed
  loadExecutionState?: (signal?: AbortSignal) => Promise<ExecutionStateFeed>
  verifierLogOverride?: string | null
  backTo?: string
}

export default function TrajectoryViewer({
  taskOverride,
  runOverride,
  agentOverride,
  vendorOverride,
  desktopTimeline,
  executionState: initialExecutionState,
  loadExecutionState,
  verifierLogOverride,
  backTo,
}: TrajectoryViewerProps = {}) {
  const { taskId, runId } = useParams()
  const { data, error } = useDatasetStore()
  const lk = useLookups(data)

  // Trajectories are externalized to public/runs/<id>.json and lazy-loaded the
  // first time a run opens (inline for uploaded & tour runs).
  const runForSteps = runOverride ?? data?.runs.find((x) => x.id === runId)
  const { steps: loadedSteps, verifierLog: loadedVerifierLog, error: stepsError } = useRunSteps(runForSteps)
  const verifierLog = verifierLogOverride ?? loadedVerifierLog
  const replayKey = runOverride?.id ?? runId

  // Deep-link a step via ?step=N (used by the guided tour and shareable links).
  const [searchParams] = useSearchParams()
  const stepParam = searchParams.get('step')
  const [activeStep, setActiveStep] = useState(() => {
    const n = Number(stepParam)
    return stepParam != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  })
  const [panel, setPanel] = useState<'step' | 'state' | 'artifacts' | 'analysis' | 'aft' | 'labels'>('step')
  const [executionState, setExecutionState] = useState(initialExecutionState)
  const [stateLoading, setStateLoading] = useState(false)
  const [stateError, setStateError] = useState<string | null>(null)
  const stateRequestRef = useRef<AbortController | null>(null)
  const [aftSteps, setAftSteps] = useState<Set<number>>(new Set())
  const [labels, setLabels] = useState<HumanLabel[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [desktopCursorMs, setDesktopCursorMs] = useState(0)
  const desktopCursorRef = useRef(0)
  const initializedReplayRef = useRef<string | undefined>()
  const timelineRef = useRef<ImperativePanelHandle>(null)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
  const toggleTimeline = () => {
    const p = timelineRef.current
    if (!p) return
    p.isCollapsed() ? p.expand() : p.collapse()
  }

  const stepLabel = useMemo(() => labels.find((l) => l.stepIndex === activeStep), [labels, activeStep])
  const stepCount = loadedSteps.length
  const hasDesktopTimeline = !!desktopTimeline?.length
  const timedDurationMs = useMemo(() => Math.max(
    (runForSteps?.durationSec ?? 0) * 1000,
    desktopTimeline?.[desktopTimeline.length - 1]?.atMs ?? 0,
    ...loadedSteps.map(stepAnchorMs),
  ), [desktopTimeline, loadedSteps, runForSteps?.durationSec])

  const moveDesktopCursor = useCallback((atMs: number) => {
    const next = Math.max(0, Math.min(atMs, timedDurationMs || atMs))
    desktopCursorRef.current = next
    setDesktopCursorMs(next)
  }, [timedDurationMs])

  const selectStep = useCallback((index: number) => {
    const next = Math.max(0, Math.min(index, Math.max(0, loadedSteps.length - 1)))
    setActiveStep(next)
    if (hasDesktopTimeline && loadedSteps[next]) moveDesktopCursor(stepAnchorMs(loadedSteps[next]))
  }, [hasDesktopTimeline, loadedSteps, moveDesktopCursor])

  const seekDesktop = useCallback((atMs: number) => {
    moveDesktopCursor(atMs)
    setActiveStep(stepIndexAt(loadedSteps, atMs))
  }, [loadedSteps, moveDesktopCursor])

  const jumpToExecutionState = useCallback((atMs: number) => {
    setPlaying(false)
    seekDesktop(atMs)
  }, [seekDesktop])

  // Reset to the start when a different trajectory opens.
  useEffect(() => {
    if (!loadedSteps.length || initializedReplayRef.current === replayKey) return
    initializedReplayRef.current = replayKey
    const firstFrameMs = desktopTimeline?.[0]?.atMs
    const initialStep = firstFrameMs == null ? 0 : stepIndexAt(loadedSteps, firstFrameMs)
    setActiveStep(initialStep)
    setPlaying(false)
    moveDesktopCursor(firstFrameMs ?? stepAnchorMs(loadedSteps[initialStep]))
  }, [replayKey, desktopTimeline, loadedSteps, moveDesktopCursor])

  useEffect(() => {
    stateRequestRef.current?.abort()
    stateRequestRef.current = null
    setExecutionState(initialExecutionState)
    setStateLoading(false)
    setStateError(null)
    return () => stateRequestRef.current?.abort()
  }, [replayKey, initialExecutionState])

  const selectPanel = useCallback((nextPanel: typeof panel) => {
    setPanel(nextPanel)
    if (nextPanel !== 'state' || executionState || stateLoading || !loadExecutionState) return
    const controller = new AbortController()
    stateRequestRef.current = controller
    setStateLoading(true)
    setStateError(null)
    loadExecutionState(controller.signal)
      .then(setExecutionState)
      .catch((reason) => {
        if (!controller.signal.aborted) setStateError(String(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setStateLoading(false)
        if (stateRequestRef.current === controller) stateRequestRef.current = null
      })
  }, [executionState, loadExecutionState, stateLoading])

  useEffect(() => {
    if (stepParam == null) return
    const n = Number(stepParam)
    if (Number.isFinite(n) && n >= 0) selectStep(Math.floor(n))
  }, [stepParam, selectStep])

  const handleAftReport = useCallback((r: AftReport | null) => {
    const s = new Set<number>()
    if (r) {
      if (r.outcome.step_where_lost != null) s.add(r.outcome.step_where_lost)
      for (const m of r.failure_modes) for (const i of m.step_indices ?? []) s.add(i)
    }
    setAftSteps(s)
  }, [])

  // Live desktop playback follows recorded wall-clock time. Dataset-only runs
  // retain the original step-per-tick behavior because they have no frame clock.
  useEffect(() => {
    if (!playing) return
    if (hasDesktopTimeline) {
      let animation = 0
      let previous = performance.now()
      const tick = (now: number) => {
        const next = Math.min(timedDurationMs, desktopCursorRef.current + (now - previous) * speed)
        previous = now
        desktopCursorRef.current = next
        setDesktopCursorMs(next)
        setActiveStep(stepIndexAt(loadedSteps, next))
        if (next >= timedDurationMs) {
          setPlaying(false)
          return
        }
        animation = requestAnimationFrame(tick)
      }
      animation = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(animation)
    }
    if (activeStep >= stepCount - 1) { setPlaying(false); return }
    const id = setTimeout(() => setActiveStep((s) => Math.min(s + 1, stepCount - 1)), 1000 / speed)
    return () => clearTimeout(id)
  }, [playing, activeStep, speed, stepCount, hasDesktopTimeline, timedDurationMs, loadedSteps])

  if (!runOverride && error) return <div className="p-8 text-rose-400">Failed to load dataset: {error}</div>
  if (!runOverride && (!data || !lk)) return <Loading />
  const task = taskOverride ?? lk?.task(taskId!)
  const run = runOverride ?? lk?.run(runId!)
  if (!task || !run) return <div className="p-8 text-zinc-400">Run not found.</div>
  const agent = agentOverride ?? lk?.agent(run.agentId)
  const vendor = vendorOverride ?? lk?.vendor(run.vendorId)
  const backHref = backTo ?? `/tasks/${task.id}`

  // The trajectory for this run is still being fetched from public/runs/<id>.json.
  if (run.stepCount > 0 && loadedSteps.length === 0) {
    if (stepsError)
      return <div className="p-8 text-rose-400">Failed to load trajectory: {stepsError}</div>
    return <Loading />
  }
  // The run object the viewer renders, with its (lazy-loaded) steps populated.
  const erun: Run = { ...run, steps: loadedSteps }

  // Metric-only runs ship aggregate numbers but no trajectory.
  if (erun.steps.length === 0) {
    return (
      <>
        <PageHeader
          title={agent ? prettyModel(agent.model) : run.agentId}
          subtitle={`${task.title} · ${run.stepCount} steps · reward ${fmtReward(run.reward)}`}
          actions={
            <>
              <Pill>{FORMAT_LABELS[run.format]}</Pill>
              <StatusBadge status={run.status} />
              <Link to={backHref} className="btn-ghost">← Task</Link>
            </>
          }
        />
        <div className="p-8">
          <div className="card p-6 text-sm text-zinc-400">
            <p>
              This run is <span className="text-zinc-200">metrics-only</span> — the source exported
              aggregate results without a step-by-step trajectory.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCell label="Reward" value={fmtReward(run.reward)} />
              <StatCell label="Steps" value={run.stepCount} />
              <StatCell label="Prompt tok" value={fmtTokens(run.tokens?.prompt)} />
              <StatCell label="Completion tok" value={fmtTokens(run.tokens?.completion)} />
            </div>
          </div>
        </div>
      </>
    )
  }

  const step = erun.steps[Math.min(activeStep, erun.steps.length - 1)]
  const desktopFrame = causalDesktopFrame(desktopTimeline, desktopCursorMs)

  function upsertLabel(patch: Partial<HumanLabel>) {
    setLabels((prev) => {
      const existing = prev.find((l) => l.stepIndex === activeStep)
      const rest = prev.filter((l) => l.stepIndex !== activeStep)
      return [
        ...rest,
        {
          stepIndex: activeStep,
          decision: existing?.decision ?? 'unsure',
          note: existing?.note ?? '',
          author: 'you',
          createdAt: new Date().toISOString(),
          ...patch,
        },
      ]
    })
  }

  return (
    <>
      <PageHeader
        title={`${agent ? prettyModel(agent.model) : run.agentId}`}
        subtitle={`${task.title} · ${erun.steps.length} steps · ${run.turns} turns · ${fmtDuration(run.durationSec)}${run.tokens?.prompt ? ` · ${fmtTokens(run.tokens.prompt)} prompt tok` : ''}`}
        actions={
          <>
            <Pill>{FORMAT_LABELS[run.format]}</Pill>
            <span className="text-sm tabular-nums text-zinc-400">reward {fmtReward(run.reward)}</span>
            <StatusBadge status={run.status} />
            <Link to={backHref} className="btn-ghost">← Task</Link>
          </>
        }
      />

      {/* Film transport */}
      <Transport
        active={activeStep}
        count={erun.steps.length}
        playing={playing}
        speed={speed}
        timeBased={hasDesktopTimeline}
        title={stepTitle(step)}
        role={step.role}
        elapsedSec={hasDesktopTimeline ? desktopCursorMs / 1000 : step.tSec ?? null}
        totalSec={run.durationSec}
        onPlay={() => {
          if (hasDesktopTimeline && desktopCursorMs >= timedDurationMs - 1) {
            moveDesktopCursor(0)
            setActiveStep(0)
          } else if (!hasDesktopTimeline && activeStep >= erun.steps.length - 1) {
            setActiveStep(0)
          }
          setPlaying((p) => !p)
        }}
        onPrev={() => { setPlaying(false); selectStep(activeStep - 1) }}
        onNext={() => { setPlaying(false); selectStep(activeStep + 1) }}
        onSeek={(i) => { setPlaying(false); selectStep(i) }}
        onSpeed={setSpeed}
        stepsCollapsed={timelineCollapsed}
        onToggleSteps={toggleTimeline}
      />

      <PanelGroup direction="horizontal" className="h-[calc(100%-89px-57px)]" autoSaveId="traj-cols">
        <Panel
          ref={timelineRef}
          collapsible
          collapsedSize={0}
          defaultSize={19}
          minSize={12}
          onCollapse={() => setTimelineCollapsed(true)}
          onExpand={() => setTimelineCollapsed(false)}
        >
        {/* Step timeline */}
        <div data-tour="timeline" className="h-full overflow-y-auto p-3">
          <div className="mb-2 px-1 text-xs uppercase tracking-wide text-zinc-500">
            {erun.steps.length} steps
          </div>
          <ol className="space-y-1">
            {erun.steps.map((s) => {
              const lbl = labels.find((l) => l.stepIndex === s.index)
              return (
                <li key={s.index}>
                  <button
                    onClick={() => { setPlaying(false); selectStep(s.index) }}
                    className={clsx(
                      'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors',
                      s.index === activeStep ? 'bg-ink-800 ring-1 ring-accent/40' : 'hover:bg-ink-800/50',
                    )}
                  >
                    <span className={clsx('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-[11px]', ROLE_STYLES[s.role] ?? 'bg-ink-700')}>
                      {ROLE_GLYPH[s.role] ?? '•'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs text-zinc-500">#{s.index + 1}</span>
                        {s.edits?.length ? (
                          <span className="chip bg-emerald-500/15 text-emerald-300" title="environment change">▦</span>
                        ) : s.toolCalls?.length ? (
                          <span className="chip bg-violet-500/15 text-violet-300">tool</span>
                        ) : null}
                        {s.mutations?.length ? (
                          <span className="chip bg-accent/15 text-accent" title="artifact change">±{s.mutations.length}</span>
                        ) : null}
                        {s.images?.length ? (
                          <span className="chip bg-sky-500/15 text-sky-300" title={`${s.images.length} message image${s.images.length === 1 ? '' : 's'}`}>img {s.images.length}</span>
                        ) : null}
                        {aftSteps.has(s.index) ? (
                          <span className="chip bg-rose-500/20 text-rose-300" title="AFT-flagged failure step">AFT</span>
                        ) : null}
                        {lbl && (
                          <span className={clsx('h-2 w-2 rounded-full', {
                            'bg-emerald-400': lbl.decision === 'correct',
                            'bg-rose-400': lbl.decision === 'incorrect',
                            'bg-amber-400': lbl.decision === 'unsure',
                          })} />
                        )}
                      </span>
                      <span className="block truncate text-zinc-200">{stepTitle(s)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
        </Panel>
        <PanelResizeHandle className="w-1 bg-ink-700 transition-colors hover:bg-accent/50" />

        {/* Environment stage — the "film screen" */}
        <Panel defaultSize={53} minSize={25}>
        <div data-tour="stage" className="flex h-full min-w-0 flex-col overflow-hidden">
          {hasDesktopTimeline && (
            <DesktopTimelineBar
              frames={desktopTimeline!}
              frame={desktopFrame}
              cursorMs={desktopCursorMs}
              durationMs={timedDurationMs}
              step={step}
              onSeek={(atMs) => { setPlaying(false); seekDesktop(atMs) }}
            />
          )}
          <div className="min-h-0 flex-1">
            <EnvironmentStage
              steps={erun.steps}
              activeStep={activeStep}
              task={task}
              desktopScreenshot={desktopFrame ? { url: desktopFrame.url } : undefined}
            />
          </div>
        </div>
        </Panel>
        <PanelResizeHandle className="w-1 bg-ink-700 transition-colors hover:bg-accent/50" />

        {/* Right rail: Step detail / Artifacts / Analysis / Label */}
        <Panel defaultSize={28} minSize={16}>
        <div className="flex h-full flex-col overflow-hidden border-l border-ink-700">
          <div data-tour="rail-tabs" className="flex border-b border-ink-700">
            {([
              ['step', 'Step'],
              ['state', `State${executionState?.events.length ? ` (${executionState.events.length})` : ''}`],
              ['analysis', 'Reward & Verifier log'],
              ['artifacts', `Changes${run.artifacts?.length ? ` (${run.artifacts.length})` : ''}`],
              ['aft', 'AFT'],
              ['labels', 'Label/Note'],
            ] as const).filter(([p]) => p !== 'state' || !!executionState?.events.length || !!loadExecutionState).map(([p, lbl]) => (
              <button
                key={p}
                data-tour={`tab-${p}`}
                onClick={() => selectPanel(p)}
                title={lbl}
                className={clsx(
                  'flex-1 px-1.5 py-2.5 text-center text-[11px] font-medium leading-tight transition-colors',
                  panel === p ? 'bg-ink-800 text-white' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {lbl}
              </button>
            ))}
          </div>
          <div data-tour="rail-content" className="flex-1 overflow-y-auto p-4">
            {panel === 'step' ? (
              <StepPanel step={step} />
            ) : panel === 'state' && stateLoading ? (
              <Loading label="Loading execution state…" />
            ) : panel === 'state' && stateError ? (
              <div className="space-y-3 text-sm text-rose-400">
                <p>Failed to load execution state: {stateError}</p>
                <button className="btn-ghost" onClick={() => { setStateError(null); selectPanel('state') }}>Retry</button>
              </div>
            ) : panel === 'state' && executionState ? (
              <ExecutionStatePanel
                feed={executionState}
                playheadMs={Math.floor((hasDesktopTimeline ? desktopCursorMs : (step.tSec ?? 0) * 1000) / 1000) * 1000}
                onJump={jumpToExecutionState}
              />
            ) : panel === 'analysis' ? (
              <GradePanel grade={run.grade} failureReason={run.failureReason} verifierLog={verifierLog} />
            ) : panel === 'aft' ? (
              <AftPanel
                run={erun}
                task={task}
                agent={agent}
                vendor={vendor}
                activeStep={activeStep}
                onJumpToStep={(i) => { setPlaying(false); selectStep(i) }}
                onReport={handleAftReport}
              />
            ) : panel === 'artifacts' ? (
              <RunArtifacts run={erun} activeStep={activeStep} onJump={(i) => { setPlaying(false); selectStep(i) }} />
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Label step #{activeStep + 1}</div>
                  <p className="mb-3 truncate text-sm text-zinc-400">{stepTitle(step)}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(['correct', 'incorrect', 'unsure'] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => upsertLabel({ decision: d })}
                        className={clsx(
                          'rounded-lg px-2 py-2 text-xs font-medium capitalize ring-1 transition-colors',
                          stepLabel?.decision === d ? DECISION_STYLES[d] : 'text-zinc-400 ring-ink-700 hover:bg-ink-800',
                        )}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Note</div>
                  <textarea
                    value={noteDraft || stepLabel?.note || ''}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    rows={3}
                    placeholder="Why is this step right/wrong?"
                    className="w-full resize-none rounded-lg border border-ink-700 bg-ink-950 p-2 text-sm text-zinc-200 outline-none focus:border-accent"
                  />
                  <button
                    className="btn-primary mt-2 w-full justify-center"
                    onClick={() => { upsertLabel({ note: noteDraft }); setNoteDraft('') }}
                  >
                    Save note
                  </button>
                </div>
                <div>
                  <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Labels ({labels.length})</div>
                  <div className="space-y-2">
                    {labels.length === 0 && <p className="text-sm text-zinc-600">No labels yet.</p>}
                    {[...labels].sort((a, b) => a.stepIndex - b.stepIndex).map((l) => (
                      <button
                        key={l.stepIndex}
                        onClick={() => selectStep(l.stepIndex)}
                        className="block w-full rounded-lg border border-ink-700 p-2 text-left hover:bg-ink-800/40"
                      >
                        <div className="flex items-center gap-2">
                          <span className={clsx('chip capitalize', DECISION_STYLES[l.decision])}>{l.decision}</span>
                          <span className="text-xs text-zinc-500">step {l.stepIndex + 1}</span>
                        </div>
                        {l.note && <p className="mt-1 text-xs text-zinc-400">{l.note}</p>}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] text-zinc-600">Labels are client-side only in this demo (not persisted).</p>
              </div>
            )}
          </div>
        </div>
        </Panel>
      </PanelGroup>
    </>
  )
}

function clockMs(ms: number): string {
  const safe = Math.max(0, ms)
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  const millis = Math.floor(safe % 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

function DesktopTimelineBar({
  frames,
  frame,
  cursorMs,
  durationMs,
  step,
  onSeek,
}: {
  frames: DesktopFrame[]
  frame: DesktopFrame | null
  cursorMs: number
  durationMs: number
  step: Step
  onSeek: (atMs: number) => void
}) {
  const framePosition = frame ? frames.findIndex((candidate) => candidate.frameIndex === frame.frameIndex) : -1
  const delta = frame ? frame.atMs - cursorMs : null
  const startMs = (step.tSec ?? 0) * 1000
  const anchorMs = stepAnchorMs(step)
  const hasInterval = anchorMs > startMs + 1
  const previous = framePosition > 0 ? frames[framePosition - 1] : null
  const next = frames[Math.max(0, framePosition + 1)]

  return (
    <div className="shrink-0 border-b border-ink-700 bg-ink-900/80 px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold uppercase tracking-wide text-amber-300">Desktop timeline</span>
        <span className="font-mono tabular-nums text-zinc-300">
          Step #{step.index + 1} {clockMs(startMs)}{hasInterval ? `–${clockMs(anchorMs)} · anchor end` : ' · anchor start'}
        </span>
        <span className="text-zinc-600">→</span>
        <span className="font-mono tabular-nums text-sky-300">playhead {clockMs(cursorMs)}</span>
        {frame ? (
          <span className="font-mono tabular-nums text-emerald-300">
            → frame #{frame.frameIndex} {clockMs(frame.atMs)} · {delta === 0 ? 'exact' : `${(Math.abs(delta!) / 1000).toFixed(3)}s behind`}
          </span>
        ) : (
          <span className="text-amber-300">→ waiting for the first captured frame</span>
        )}
        <span className="ml-auto text-zinc-500" title="The selected step sets the playhead anchor. Desktop always chooses the latest captured frame at or before that time, so it never shows a future screen.">
          latest causal frame · no future look-ahead
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button disabled={!previous} onClick={() => previous && onSeek(previous.atMs)} className="btn-ghost px-1.5 py-0.5 disabled:opacity-30" title="Previous desktop frame">‹</button>
        <input
          aria-label="Desktop time"
          type="range"
          min={0}
          max={Math.max(1, durationMs)}
          step={10}
          value={Math.min(cursorMs, Math.max(1, durationMs))}
          onChange={(event) => onSeek(Number(event.target.value))}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-amber-400"
        />
        <button disabled={!next || next === frame} onClick={() => next && onSeek(next.atMs)} className="btn-ghost px-1.5 py-0.5 disabled:opacity-30" title="Next desktop frame">›</button>
        <span className="w-20 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-500">{frames.length} frames</span>
      </div>
    </div>
  )
}

function Transport({
  active, count, playing, speed, timeBased, title, role, elapsedSec, totalSec, stepsCollapsed,
  onPlay, onPrev, onNext, onSeek, onSpeed, onToggleSteps,
}: {
  active: number; count: number; playing: boolean; speed: number; timeBased: boolean; title: string; role: string
  elapsedSec: number | null; totalSec: number | null; stepsCollapsed: boolean
  onPlay: () => void; onPrev: () => void; onNext: () => void
  onSeek: (i: number) => void; onSpeed: (s: number) => void; onToggleSteps: () => void
}) {
  const hasTime = elapsedSec != null && totalSec != null && totalSec > 1
  return (
    <div data-tour="transport" className="flex items-center gap-3 border-b border-ink-700 bg-ink-900/60 px-4 py-2.5">
      <button
        onClick={onToggleSteps}
        className="btn-ghost px-2"
        title={stepsCollapsed ? 'Show steps panel' : 'Hide steps panel'}
      >
        {stepsCollapsed ? '☰' : '⟨'} <span className="text-xs">Steps</span>
      </button>
      <div className="flex items-center gap-1">
        <button onClick={onPrev} disabled={active === 0} className="btn-ghost px-2 disabled:opacity-30" title="Previous step">⏮</button>
        <button onClick={onPlay} className="btn-primary px-3" title={playing ? 'Pause' : 'Play'}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button onClick={onNext} disabled={active >= count - 1} className="btn-ghost px-2 disabled:opacity-30" title="Next step">⏭</button>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs tabular-nums text-zinc-500">
          {active + 1} / {count}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          value={active}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="h-1 w-44 cursor-pointer accent-accent"
        />
      </div>
      {hasTime ? (
        <span className="shrink-0 font-mono text-xs tabular-nums text-zinc-400" title="elapsed / total wall-clock time">
          ⏱ {fmtDuration(elapsedSec!)} <span className="text-zinc-600">/ {fmtDuration(totalSec!)}</span>
        </span>
      ) : totalSec && totalSec > 1 ? (
        <span className="shrink-0 font-mono text-xs text-zinc-500" title="total wall-clock time">⏱ {fmtDuration(totalSec)} total</span>
      ) : null}
      <span className={clsx('chip shrink-0 capitalize', ROLE_STYLES[role])}>{role}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-400">{title}</span>
      <div className="flex shrink-0 items-center gap-1 text-xs text-zinc-500" title={timeBased ? 'Recorded wall-clock playback speed' : 'Steps advanced per second'}>
        {timeBased ? 'wall time' : 'step speed'}
        {(timeBased ? [1, 2, 4, 8, 16] : [0.5, 1, 2, 4]).map((s) => (
          <button
            key={s}
            onClick={() => onSpeed(s)}
            className={clsx('rounded px-1.5 py-0.5', speed === s ? 'bg-accent text-white' : 'hover:text-zinc-200')}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  )
}

function StepPanel({ step }: { step: Step }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx('grid h-6 w-6 place-items-center rounded text-xs', ROLE_STYLES[step.role])}>
          {ROLE_GLYPH[step.role] ?? '•'}
        </span>
        <h2 className="text-sm font-semibold capitalize text-white">{step.role}</h2>
        <span className="text-xs text-zinc-500">step {step.index + 1}</span>
        {step.tokens?.completion != null && (
          <span className="ml-auto text-[11px] text-zinc-500">
            {fmtTokens(step.tokens.prompt)} in · {fmtTokens(step.tokens.completion)} out
          </span>
        )}
      </div>
      {step.reasoning && (
        <Field label="Reasoning" muted><Markdown content={step.reasoning} className="opacity-90" /></Field>
      )}
      {step.text && (
        <Field label={step.role === 'tool' ? 'Tool message' : 'Message'}>
          <SmartContent text={step.text} />
        </Field>
      )}
      <StepImageGallery images={(step.images ?? []).filter((image) => image.kind === 'input')} label="Input images" />
      {step.toolCalls?.map((tc, i) => (
        <div key={i}>
          <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
            Tool call
            <Pill className="bg-violet-500/15 font-mono text-violet-300 normal-case">{tc.name}</Pill>
          </div>
          <CodeBlock content={prettyJson(tc.args)} language="json" lineNumbers={false} />
        </div>
      ))}
      {step.observation && (
        <Field label="Observation" muted><SmartContent text={step.observation} mono /></Field>
      )}
      <StepImageGallery images={(step.images ?? []).filter((image) => image.kind === 'output')} label="Output images" />
      {step.mutations && step.mutations.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
            Artifact changes
            <span className="chip bg-accent/15 text-accent normal-case">{step.mutations.length}</span>
          </div>
          <MutationList mutations={step.mutations} />
        </div>
      )}
      {!step.text && !step.reasoning && !step.toolCalls?.length && !step.observation && !step.images?.length && (
        <p className="text-sm text-zinc-600">No content for this step.</p>
      )}
    </div>
  )
}

function StepImageGallery({ images, label }: { images: StepImage[]; label: string }) {
  if (!images.length) return null
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
        {label}
        <span className="chip bg-sky-500/15 text-sky-300 normal-case">{images.length}</span>
      </div>
      <div className="space-y-2">
        {images.map((image, index) => (
          <figure key={`${image.kind}:${image.source}:${image.sha256 ?? image.url}:${index}`} className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
            <a href={image.url} target="_blank" rel="noreferrer" className="block bg-black/30" title="Open original image">
              <img
                src={image.url}
                alt={image.label}
                loading="lazy"
                className="mx-auto block max-h-80 w-full object-contain"
              />
            </a>
            <figcaption className="flex flex-wrap items-center gap-1.5 border-t border-ink-700 px-2.5 py-2 text-[10px]">
              <span className={clsx('chip normal-case', image.kind === 'input' ? 'bg-sky-500/15 text-sky-300' : 'bg-violet-500/15 text-violet-300')}>
                {image.source}
              </span>
              <span className="text-zinc-300">{image.label}</span>
              {image.atSec != null && <span className="ml-auto font-mono tabular-nums text-zinc-500">{clockMs(image.atSec * 1000)}</span>}
              {image.mimeType && <span className="text-zinc-600">{image.mimeType}</span>}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

function Field({ label, children, muted }: { label: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={clsx(
        'max-h-96 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3',
        muted && 'text-zinc-400',
      )}>
        {children}
      </div>
    </div>
  )
}

/** Render text as a colored ARC grid if it's a 2D number array, else pretty
 *  JSON if it parses, else Markdown. */
function SmartContent({ text, mono }: { text: string; mono?: boolean }) {
  const t = text.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    const grids = tryParseArcGrids(t)
    if (grids) return <ArcGridView grids={grids} />
  }
  if (mono && (t.startsWith('{') || t.startsWith('['))) {
    try {
      return <CodeBlock content={JSON.stringify(JSON.parse(t), null, 2)} language="json" lineNumbers={false} />
    } catch {
      /* fall through to markdown */
    }
  }
  // Tool observations are often plain logs, not markdown — keep them monospace
  // unless they clearly contain markdown structure.
  const looksMarkdown = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|.*\||```)/.test(text) || /\*\*[^*]+\*\*/.test(text)
  if (mono && !looksMarkdown) {
    return (
      <pre className="overflow-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-zinc-300">
        {text}
      </pre>
    )
  }
  return <Markdown content={text} />
}

function prettyJson(s?: string): string {
  if (!s) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

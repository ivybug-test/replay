# Replay migration map

Replay uses the ATIF Trajectory Viewer as its React UI foundation and adopts
the existing `/home/binqiu/oss-replay` service as its first backend. The goal is
to migrate product capabilities without duplicating trajectory truth or OSS
credentials in the browser.

## Canonical trajectory boundary

ATIF v1.8 is the only canonical trajectory model consumed by new Replay code:

```text
native Harness ATIF v1.8 ───────────────┐
                                        ├─> ATIF validator ─> ATIF-to-Viewer ─> Run / Step UI
legacy OSS Agent Work ─> compatibility ─┘

desktop frames ───────────────────────────────────────────────────────────────> Desktop timeline
execution-state/v1 ───────────────────────────────────────────────────────────> State panel
```

- `src/lib/atif.ts` defines and validates the Harbor ATIF contract.
- `src/lib/atifToViewer.ts` is the sole canonical trajectory-to-UI projection.
- `src/lib/legacyTraceToAtif.ts` is the compatibility adapter for existing
  Harness traces. It emits ATIF v1.8 before any Viewer mapping occurs.
- `/api/trajectory` returns a producer's native ATIF v1.8 document unchanged.
  Replay falls back to `/api/agent-work` only when that endpoint returns 404.
- ATIF `ContentPart(type="image")` values in `message` and
  `observation.results[].content` carry LLM input/output images. Relative image
  paths are transported by `/api/atif-media`; they are not modeled as a Replay
  extension.
- Desktop capture timing and `execution-state/v1` remain sidecars by design.

## Working now

- ATIF viewer task/showcase/upload/AFT screens remain available.
- `/live` reads the existing OSS run catalog.
- A run opens its real tasks and evaluator scores.
- A task loads the complete semantic Agent Work sequence without the upstream
  120-step upload limit.
- Browser ZIP import now keeps every ATIF step and resolves ATIF v1.6–v1.8
  `ContentPart(type="image", source.path=...)` references to ZIP image bytes.
- Agent messages, reasoning, tools, results, tokens, elapsed time and causal
  desktop screenshots are adapted to the film-style trajectory viewer.
- Screenshot bytes continue to come from the existing authenticated backend;
  they are not copied into localStorage.

## Migration order

1. **Replay core:** replace step-per-second playback with the authoritative
   `episode_elapsed_ms` clock and lazy 30-second frame/trace windows.
2. **Agent Debug:** add role grouping, global Turn navigation, outline loading,
   tool progress and model-input images from `/api/agent-*`.
3. **Task Architect:** port the durable Codex session, SSE tool activity,
   EvidenceRef links and presentation state.
4. **Run Architect:** port catalog chat, background analysis progress, task
   reports and Research Calibration reports.
5. **Persistence and serving:** make this React build the frontend published by
   the Python service; retain SQLite/OSS as server-side state and remove the
   browser-only upload persistence for large trajectories.

## Boundaries

- `/home/binqiu/oss-replay` remains unchanged during the bootstrap phase.
- Replay owns the new React user experience; OSS Replay remains the source of
  truth for catalog, traces, frames, reports, sessions and evidence.
- The upstream `LICENSE`, attribution and source credits must be retained.

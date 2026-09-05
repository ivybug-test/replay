# Replay

Replay is a new agent-trajectory workbench derived from ATIF Trajectory Viewer.
It keeps the upstream task browser, film-style trajectory view, upload flow,
specialized renderers and AFT panels, and adds a live integration with the
existing OSS Replay backend in `/home/binqiu/oss-replay`.

A standalone read-only OSS API is implemented in [backend/README.md](./backend/README.md),
with catalog/history queries and native/legacy ATIF replay. The existing frontend
proxy has not yet been switched to this backend.

The first migration slice is available at `/live`: it lists real OSS runs,
opens their tasks, loads the complete semantic Agent Work sequence, and shows
causal desktop screenshots through the existing authenticated image API.

```bash
npm install
npm run dev          # http://127.0.0.1:5174/live
```

The Vite development server proxies `/api` to `http://127.0.0.1:18767`. Set
`REPLAY_BACKEND_URL` to use another backend. See [MIGRATION.md](./MIGRATION.md)
for the capability map and migration order.

Native ATIF live replay is served directly from immutable OSS chunks. Set
`REPLAY_OSS_ENV_FILE` to an env file containing only the standard `OSS_*`
settings (the production unit points at the Harness env file); credentials
remain server-side.

Production deployment on this host is managed by the user systemd service
`replay-18768.service`:

```bash
npm run deploy        # build, restart, and verify http://127.0.0.1:18768/live
```

### Execution State

The State panel shows the Planner plan at the current playback position, node
outcomes and global turn budget, followed by Observer descriptions. It reads
`planner_state` and `observer_interval` events from live/archived Harness ATIF,
using `state.planner` or `state.observer` only when the corresponding history is
missing. Time links jump to the source timestamp. Old Goal, Action, Checkpoint
and other execution metrics are no longer displayed.

### Steps navigation

The Steps sidebar defaults to **By agent** for attributed trajectories. Agent
branches follow ATIF parent/child trajectories and tool-result delegation
references; the parent-step link jumps to the dispatch. Expand all / Collapse all
show or hide each agent's own steps while keeping every agent header and the
delegation hierarchy visible. Child agents can expand independently of folded
parents. The entire sidebar can also be hidden.
**Chronological** restores the flat time-ordered list without changing step
numbers or playback. Live polls preserve manual folds; selecting a different
step through playback, State or another panel reveals only that agent's steps.
Older datasets without agent metadata remain a flat list. No delegation edges
are guessed from message roles or adjacent timestamps.

Checks: `npm test`, `npm run lint`, and `npm run build`. For browser interaction
checks, run `npx playwright install chromium` once, then `npm run test:browser`
against the running build (default `http://127.0.0.1:18768`, overridable with
`REPLAY_TEST_URL`). Browser tests mock their own API responses, not server data.

## OSWorld 2.0 tasks

The Tasks page includes a separate `public/osworld-v2.dataset.json` catalog,
merged with the original examples. Rebuild it from a local OSWorld-V2 checkout:

```bash
/home/binqiu/OSWorld-V2/.venv/bin/python3 scripts/import_osworld.py --root /home/binqiu/OSWorld-V2
npm run deploy
```

The importer uses `evaluation_examples/test_v2.json` as the task list and
statically reads `evaluation_examples/task_class/task_<id>.py`. It does not
execute task modules. It exports instructions, application metadata and source
hashes, without setup/evaluator code or reference assets. Runtime-dependent
values remain explicit `{{variable}}` placeholders, documented in each task's
`metadata.json`. Reimports replace only this catalog and preserve stable task
IDs (`osworld-v2-<id>`). Missing files or invalid task definitions fail the import
before the existing catalog is replaced. Runs remain available separately in Live.

Capabilities come from the ten named category JSON files in
`evaluation_examples/`. Every imported task retains all of its labels;
category entries outside `test_v2.json` (such as task 082) do not add tasks.
The Tasks page filters capabilities using OR, then intersects them with the
selected difficulty. Snapshot and application metadata remain separate from
capabilities; each task appears only once.

Difficulty is taken directly from the team's knowledge-base per-task labels at
`http://47.120.53.174/osworld-2.html`, with source links on task detail pages.
The checked-in `scripts/osworld_difficulty.json` snapshot keeps regular imports
offline and repeatable. To refresh difficulty labels, run
`python3 scripts/import_osworld_difficulty.py`, then rerun the task importer.
This uses baseline difficulty labels, not human completion-time estimates.

Importer checks: `python3 -m unittest discover -s tests -p 'test_*osworld*.py'`.
After building and starting Replay, run `node tests/osworld.browser.mjs` to
check the catalog, task pages, reloads and instruction placeholders in Chromium.

## Upstream project

The source below describes the original project on which Replay is based.
Modified files are maintained by the Replay project; the original Apache-2.0
license and attribution are retained in `LICENSE` and `NOTICE`.

## ATIF Trajectory Viewer

Built by [**Lin Shi** (Slimshilin)](https://github.com/Slimshilin) -- core
contributor to [**Terminal-Bench**](https://www.tbench.ai/) and
[**Harbor**](https://www.harborframework.com/), leading the
[Harbor Adapter Team](https://www.harborframework.com/docs/datasets/adapters-human).

**Live demo → https://atif-trajectory-viewer.vercel.app/**

As agent trajectories become longer, multi-modal, multi-turn, and more
difficult to comprehend and analyze, we need better visualization. This repo
serves as a demo for a **trajectory viewer, analyzer, and annotator** platform
for Harbor-format tasks and ATIF agent trajectories. Source code and sample
[Terminal-Bench](https://www.tbench.ai/) and [Harbor Adapter](https://www.harborframework.com/docs/datasets/adapters-human)
tasks are provided to show features. You are welcome to use, refer to, or
build on top of the repo to optimize your own agent-trajectory visualization.

This is a static, browser-only React + Vite app -- no backend, no login, no upload required;
everything runs in your tab.

> **Known limitations.** Not all features are perfectly implemented -- e.g. the
> reconstructed agent-view of the container filesystem is inferred from the
> trajectory's tool calls and is not always faithful, and the example Agent
> Failure Taxonomy will not apply cleanly to every scenario. Treat the audit
> output as an example, not a confident verdict.

## Samples

- **Terminal-Bench 2.1** -- 10 task definitions × 4 agent submissions (Anthropic / OpenAI / Google / Z-AI), 40 trajectories fetched lazily from the official leaderboard.
- **Harbor-Index annotate bundle** -- 35 tasks, **every agent trial ingested** (~20 per task, 761 trajectories total), each task carrying one **pre-baked AFT report** on its annotated trial. Trajectories are externalized to `public/runs/<runId>.json` and lazy-loaded when a run opens, so `dataset.json` stays small. Tasks span spreadsheets, ARC-AGI grids, web search, lab images, SWE bug fixes, ML pipelines, scientific reasoning, and python performance.
- Everything cited above is Apache-2.0.

## Features

### 1. Task page -- Human ⇄ Agent file system, multi-run table

Browse the raw task directory (`task.toml`, `instruction.md`, `environment/`, `tests/`, `solution/`) or switch to the container filesystem the agent sees, reconstructed from the Dockerfile's `COPY` / `WORKDIR` rules. Click any file to render it inline -- markdown, code, images, multi-tab spreadsheets, ARC-AGI grids -- and the run table below lists every trial that's been ingested for the task.

![Task page](./img/task_image.png)

### 2. Trajectory page -- film-style replay + agent file system + terminal

A scrubbable step timeline on the left, the agent's live workspace (terminal + filesystem with the **Human ⇄ Agent** toggle and GitHub-style **A / M / T / D** status badges) in the middle, and the active step's message / reasoning / tool call / observation on the right. The viewer parses Write / Edit / apply_patch tool calls **and** shell-based writes (`cat > x << EOF`, `python3 << EOF`, `python3 -c`, `echo > x`, `tee`, `cp / mv / rm / sed -i`) so files appear in the agent view regardless of how the agent wrote them.

![Trajectory page](./img/traj_page.png)

### 3. AFT failure-mode analysis (Agent Failure Taxonomy v1.0)

A four-axis audit (**A** Stage · **B** Root cause · **C** Behaviour · **D** Impact). A pre-computed report loads instantly for each task's annotated trial; for every other ingested trial, **Apply AFT analysis** uses your browser-stored Anthropic / OpenAI key to generate one. Each failure mode lists its A×B×C×D code, an evidence quote, the implicated step indices (clickable -- they jump the whole viewer to that step), and a counterfactual fix. Reward, verifier log, rubric subscores, and step-level human annotation all live in the same right rail.

![AFT panel](./img/AFT_demo.png)

### 4. Specialised renderers

Spreadsheets become multi-tab grids. `.xlsx` workbooks parse with openpyxl into `@@SHEET:` blocks. **ARC-AGI** tasks auto-detect their 2D number arrays and render colored cells with an **expected ↔ actual** comparison. Web fetches render as the page the agent saw. Computer-use steps show screenshots.

### 5. Bring your own data

Drop a Harbor task zip on `/upload`; it parses in-browser and never leaves your machine. Or rewrite `scripts/ingest.py` to emit `public/dataset.json` for whatever benchmark format you have.

## Use it

1. **Online:** open https://atif-trajectory-viewer.vercel.app/ and click `▶ Start guided tour` (or `Feature showcase`).
2. **Locally:**
   ```bash
   npm install
   npm run dev          # http://localhost:5173
   ```

## Citation

If this viewer helps your work, please cite it:

```bibtex
@software{shi_atif_trajectory_viewer_2026,
  author  = {Shi, Lin},
  title   = {ATIF Trajectory Viewer: a visualization platform for Harbor-format agent tasks and ATIF trajectories},
  year    = {2026},
  url     = {https://github.com/Slimshilin/ATIF-trajectory-viewer},
  version = {0.1}
}
```

Inline: *Lin Shi, ATIF Trajectory Viewer, 2026. https://github.com/Slimshilin/ATIF-trajectory-viewer*

## License

Apache-2.0. Terminal-Bench 2.1 and the Harbor-Index annotate bundle are
redistributed under their original Apache-2.0 terms with attribution
preserved in each source's `coverage` note.

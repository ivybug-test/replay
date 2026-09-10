# Replay 仓库说明：功能、文件与运行

深入参考：[backend/README.md](../backend/README.md)（接口字段、OSS 布局、缓存与资源上限、
分析流水线、部署与运维）。两者冲突时以后端文档与代码为准。

---

# 一、认识项目

## 1.1 项目全貌

三层，职责不重叠：

| 层 | 位置 | 职责 |
|---|---|---|
| 前端 | `src/`（React 18 + TypeScript + Vite，纯静态构建） | 全部页面与交互；ATIF 增量合并、ATIF → UI 投影；不持有任何 OSS 凭据 |
| Node 服务 | `server.mjs` + `server/proxyApi.mjs` | 托管构建产物、SPA 回退、`/healthz`、把 `/api/*` 反向代理到后端；没有 OSS 读取器与凭据 |
| 后端 | `backend/`（Python + FastAPI，只读 OSS） | OSS 访问、执行索引、轨迹解析并统一为 ATIF v1.8、图片、AFT 分析 |

```text
OSS ──(凭据只在后端)──> 后端 ──> 统一 ATIF v1.8 / 图片 / 执行索引 / AFT 报告 ──> 前端
```

## 1.2 五条硬约定（改动前先读）

1. **统一 ATIF v1.8**：前端只消费后端归一化后的 ATIF。原生 ATIF 原样返回；旧格式
   trace 由后端 `backend/parsers/legacy_to_atif.py` 转换（唯一实现）。前端不做格式识别，
   也不存在构建模式开关。
2. **判定权在后端**：执行是否终态、分析作业阶段、报告是否过期、模型是否在产品里可见，
   都由后端随响应发布（`terminal`、`phase`/`phase_label`、`current`、`hidden`），
   前端只读这些字段，不自行推断（唯一例外是字段缺失时对旧后端的回退）。
3. **单一数据路径**：一个执行要么读终态轨迹、要么读实时增量，两者都没有时显示"等待中"。
   不会回退到 `/api/agent-work` 这种"同一份轨迹的第二种表示"。
4. **凭据只在后端**：前端与 Node 进程都不接触 OSS 凭据；浏览器只访问同源 `/api`。
5. **后端只读 OSS**：唯一的写入是本机 SQLite（执行索引、AFT 报告、cohort 报告）。

## 1.3 术语表

| 术语 | 含义 | 代码位置 |
|---|---|---|
| **ATIF** | Agent Trajectory Interchange Format，本仓库的统一轨迹契约（当前 v1.8）。所有轨迹源最终都归一化成它 | `src/lib/atif.ts`（前端类型与校验）、`backend/parsers/atif_stream.py`（后端校验） |
| **Harness 扩展** | ATIF 文档 `extra.osworld_harness` 里的生产者扩展：run 元数据、desktop timeline、planner/observer 事件、subagent 生命周期 | `src/lib/osworldAtifExtra.ts` |
| **batch / run** | 一次批量实验（OSS 目录名形如 `20260904T…`）。UI 里叫 run | 后端 `CatalogService` |
| **execution（执行）** | 由 `batch_id + task_key` 唯一定位的一次任务执行 | 后端 `CatalogService`/`ReplayService` 的 `run` + `task` 参数 |
| **task_key** | 批次内的执行项，形如 `0001-003` | 同上 |
| **task_id** | OSWorld 原始三位编号，如 `003`；前端从 `metadata.osworld_task_id` 读取 | `src/lib/osworld.ts` |
| **Observer** | 周期性旁观者报告（`observer_interval` 事件），State 面板展示 | `src/lib/observerFeed.ts` |
| **Planner** | 计划节点与全局轮次预算（`planner_state` 事件，契约 `planner-state/v1`） | `src/lib/plannerState.ts` |
| **HoH** | 长程 harness 的提交形态（`subagent_lifecycle` 事件：plan / verification / invalidation / claims）。State 面板据此重建 artifacts、task items、verified/gaps | `src/lib/hohState.ts`、`src/components/HohStateCard.tsx` |
| **AFT** | 失败分析。两套引擎：**后端 Analyzer**（OSS 执行，映射到 lhht taxonomy）与**浏览器内 AFT v1.0**（内置/上传数据，用读者自己的 API key） | `backend/native_analysis.py` / `src/lib/aft.ts` |
| **lhht taxonomy** | 长程 harness 问题分类法，版本 `lhht/2026-09-07.1`，8 个节点 + 来源与 locator | `backend/aft_taxonomy.py`（唯一实现） |
| **cohort report** | 跨任务的独立报告（当前只有 `todolist-quality`），不可变 revision，经脚本导入 | `backend/cohort_reports.py`、`src/components/TodolistTaskReport.tsx` |
| **desktop timeline / 帧** | 桌面截图序列及其时间轴，图片按需从 `/api/frame` 取 | `backend/parsers/replay_view.py`、`src/lib/stage.ts` |
| **execution-state/v1 · v2** | 旧的执行状态事件族与便携扩展；State 面板**不再**读它，仅为已停止的迁移前端保留 | `backend/parsers/execution_state.py` |

## 1.4 一次回放请求的完整链路

以打开 `/live/runs/<batchId>/tasks/<taskKey>` 为例（内置数据的 `/tasks/:id/runs/:rid` 走同一投影）：

1. `LiveTrajectory` 调用 `fetchViewerBundle()`，并行发出两个请求：
   - `GET /api/batch?run=` → 批次与任务摘要（状态、`terminal`、`passed`、模型与框架归属）；
   - `GET /api/trajectory?run=&task=` → 终态 ATIF。
2. 后端 `ReplayService._load_view` 选择来源：原生完整 ATIF → 直接校验返回；只有实时清单
   → 读尚未消费的分块；只有旧日志 → `legacy_to_atif` 转换。返回前补齐 Harness run 元数据与
   desktop timeline（生产者自带的 `extra.osworld_execution_state` 原样保留）。
3. 前端若拿不到终态文档，就改走 `GET /api/atif-live?after=<cursor>` 增量：`has_more` 为真时
   ~100ms 追平，否则 ~2s 轮询；两次都没有可用数据时显示"等待中"并继续重试。
4. 前端 `parseAtifTrajectory`（严格 v1.8）→ `atifTrajectoryToSteps`（唯一投影）得到步骤、
   agent 树与图片 URL，交给查看器渲染。
5. State 面板从**同一份 ATIF** 的 Harness 扩展折出 Planner / Observer / HoH，不额外请求
   `/api/execution-state`。
6. 图片按需加载：`/api/frame`（桌面帧）、`/api/atif-media`（ATIF 引用的图片）。
7. 后端在批次/实时响应里发布 `terminal`；为真且没有更多分页时停止轮询。

AFT 链路：面板 `GET /api/execution-analysis` 读状态 → 无报告时可 `POST` 启动作业（后端 Codex
进程池）→ 每 3 秒轮询进度直到 `terminal` → 报告 `current=false` 表示已过期，前端据此提示并
在重新分析时传 `force`。

## 1.5 文档地图

| 文档 | 作用 | 什么时候读 |
|---|---|---|
| `README.md` | 产品概览：入口 URL、开发/部署速查、Execution State / Steps / AFT 三个功能段、OSWorld 目录说明，以及上游项目 ATIF Trajectory Viewer 的原始说明（归属与许可） | 第一次接触本项目 |
| `docs/guide.md`（本文） | 全仓库总览：术语、链路、模块与逐文件职责、运行手册、改代码前必读 | 接手、评审、找文件 |
| `backend/README.md` | 后端唯一参考：目录职责、CatalogService/ReplayService 行为、OSS 数据布局、环境变量表、HTTP 接口表、分析流水线、**部署与运维**、验证记录 | 改后端、查接口、部署排障 |
| `deploy/README-memory-guard.md` | 主机内存压力守护的规则与操作：阈值、恢复条件、安装/查看/停用命令、验证方式 | 主机内存告警、服务被自动停掉时 |
| `public/aft-prompt.md` ⚠️运行时资产 | 浏览器内 AFT 引擎的提示词模板，`AftPanel`/`AftReference` 在浏览器里 fetch 它 | 想调整浏览器 AFT 的行为时 |
| `skills/single-task-execution-analysis/SKILL.md` ⚠️运行时资产 | 后端 Analyzer 分析单个 execution 的技能提示词 | 想调整单任务报告口径时 |
| `skills/run-common-problem-analysis/SKILL.md` ⚠️运行时资产 | 后端 Run Analyzer 归纳入 run 级共性问题的技能提示词 | 想调整 run 报告口径时 |
| `.env.example` | 前端构建期环境变量模板（`VITE_*`） | 配置前端构建时 |

两个 skill 由 `backend/native_analysis.py` 以**文件路径**注入 Codex（`TASK_ANALYSIS_SKILL`/
`RUN_ANALYSIS_SKILL`），改动会直接改变分析结果，且没有自动化测试兜底。

---

# 二、代码地图

## 2.1 前端 `src/`

### 2.1.1 入口与外壳

| 文件 | 作用 |
|---|---|
| `src/main.tsx` | React 挂载点：先安装 GA4（`VITE_GA_ID` 未设置时完全 no-op），再在 `BrowserRouter` → `AuthProvider` → `DatasetProvider` 里渲染 `App`；末尾挂 Vercel Analytics / Speed Insights（仅 Vercel 部署生效，其他地方 no-op） |
| `src/App.tsx` | 路由表与 Router 感知的 GA4 pageview 钩子；`/` 重定向到 `/live` |
| `src/index.css` | Tailwind 指令与全局基础排版（色板令牌本身在 `tailwind.config.js`） |
| `index.html` | HTML 外壳（挂在 `#root`），标题与字体预加载 |
| `src/vite-env.d.ts` | 一行 `vite/client` 类型引用 |

路由（全部在 `App.tsx`，共享 `Layout`）：`/live`、`/live/runs/:batchId`、
`/live/runs/:batchId/tasks/:taskKey`、`/overview`、`/aft-reports`、
`/aft-reports/:reportId`、`/aft-reports/cohort/:reportId`、`/insights`、`/tasks`、
`/tasks/:taskId`、`/tasks/:taskId/runs/:runId`、`/upload`、`/showcase`、`/quickstart`。

### 2.1.2 页面 `src/pages/`

| 文件 | 作用 |
|---|---|
| `LiveRuns.tsx` | `/live`：OSS 批次列表，日期 + 状态（running/interrupted/completed）筛选；每张 run 卡片显示状态、任务数、AFT 状态（含**过期**标记）与"分析/重新分析"按钮 |
| `LiveRunDetail.tsx` | `/live/runs/:batchId`：单个批次的配置与任务列表（状态、得分），入口回 Live |
| `LiveTrajectory.tsx` | `/live/runs/:batchId/tasks/:taskKey`：轮询 `fetchViewerBundle` 并交给查看器；轮询节奏与终止条件以后端发布的 `terminal` 为准（旧后端回退到状态名集合），失败按指数退避重试 |
| `TrajectoryViewer.tsx` | 轨迹查看器（932 行，核心页面）：三栏布局、播放时钟、步骤选择与深链参数（`step`/`at_ms`/`turn`/`panel`）、右侧六个面板、人类标注状态、引导锚点 |
| `TaskDetail.tsx` | `/tasks/:taskId`：任务说明、能力标签、难度来源链接、环境（Dockerfile/组合）、Human⇄Agent 文件视图；OSWorld 任务显示后端执行索引，其它任务显示内置运行表 |
| `Tasks.tsx` | `/tasks`：厂商分组目录（OSWorld 默认展开、其余折叠）、能力 OR × 难度交集筛选、每卡片的执行/得分摘要（OSWorld 来自 `/api/task-stats`） |
| `Overview.tsx` | `/overview`：模型排行榜（覆盖率、完成率、通过率、得分区间、平均耗时），数据来自 `/api/leaderboard` |
| `AftReports.tsx` | `/aft-reports`：进行中的 run 分析进度、run 报告列表（含过期标记）、cohort 报告卡片、可展开的 taxonomy 表（节点定义、Harness locus、映射范围、支持来源与 locator） |
| `AftReportDetail.tsx` | `/aft-reports/:reportId`：单个 run 报告（Markdown）、概览指标、重新生成（用报告自己的模型，仅在已知过期或上次失败时强制）、revision 变化自动跳转 |
| `CohortReportDetail.tsx` | `/aft-reports/cohort/:reportId`：独立 cohort 报告，交给 `TodolistTaskReport` 渲染 |
| `AftInsights.tsx` | `/insights`：**仅**汇总内置样例报告（`public/aft/`），live run 不在此页 |
| `Upload.tsx` | `/upload`：拖入 Harbor 任务 zip，浏览器内解析成数据集并存入 `localStorage`，可清空 |
| `Showcase.tsx` | `/showcase`：按渲染器/能力列举示例，直达对应轨迹 |
| `QuickStart.tsx` | `/quickstart`：上手步骤与引导入口（`startTour`） |

### 2.1.3 组件 `src/components/`

| 文件 | 作用 |
|---|---|
| `Layout.tsx` | 站点外壳：侧栏导航（OSS runs / Leaderboard / AFT reports / Quick start / Feature showcase / Tasks / AFT insights / Upload）、可折叠、页头组件 |
| `ui.tsx` | 通用小件：`StatusBadge`、`StatCell`、`RangeStat`、`Pill`、`Loading` |
| `StepTimeline.tsx` | 步骤侧栏：`By agent`（按 agent 分组、折叠/展开、父步跳转）与 `Chronological` 两种模式；标注与 AFT 命中标记；`formatContextSize` |
| `EnvironmentStage.tsx` | 环境"舞台"（915 行）：终端输出、文件树（Human⇄Agent 视图）、桌面截图随播放推进、ARC expected↔actual 对照、文件状态徽标 |
| `EnvironmentPanel.tsx` | 任务环境说明：解析 Dockerfile / compose，展示基础镜像、拷贝文件、服务与端口 |
| `EnvFileBrowser.tsx` | 任务详情里的文件浏览：Human（原始任务目录）⇄ Agent（容器文件系统），带 `env/created/modified/touched` 徽标 |
| `FileTree.tsx` | 文件树：按类型图标、可展开目录 |
| `FileRenderer.tsx` | 文件内容渲染：markdown、代码高亮、diff、HTML 沙箱 iframe、多页签表格、图片、PDF、ARC 网格、二进制提示 |
| `Markdown.tsx` | 零依赖 Markdown 渲染（自研），**不渲染原始 HTML**，用于不可信厂商文本与报告 |
| `CodeBlock.tsx` | 代码块：语法高亮 + 可选行号 |
| `ArcGrid.tsx` | ARC-AGI 网格渲染（0–9 调色板），被文件渲染器与 Markdown 共用 |
| `GradePanel.tsx` | `Reward & Verifier log` 面板：总分、通过判定（优先用运行自身的 `passed`）、子项、完整 verifier 输出、findings |
| `ExecutionStatePanel.tsx` | `State` 面板：Planner 计划与轮次预算、Observer 历史（分页）、HoH 快照，均跟随播放位置 |
| `HohStateCard.tsx` | HoH 快照卡片：fixed artifacts、当前 loop 的 task items（target/preserve/gate）、verified/gaps 及失效原因、证据展开与时间跳转 |
| `BackendExecutionAnalysis.tsx` | 后端 AFT 面板（623 行）：任务报告渲染（v2 / 旧 v1 两种结构）、作业阶段与进度、模型选择（读后端 `hidden` 策略）、过期提示、重新分析 |
| `AftPanel.tsx` | 浏览器内 AFT 引擎的界面：引擎/模型/key/baseURL 配置、运行单次审计、per-run 结果与反馈（`localStorage`）、pass 选择与共识视图 |
| `AftReference.tsx` | 侧滑参考页：AFT v1.0 taxonomy 说明 + 完整提示词（运行时 fetch `public/aft-prompt.md`） |
| `TaskExecutionHistory.tsx` | 后端执行索引表格：模型/状态筛选、keyset 分页、索引同步状态，首页 15 秒刷新（翻页后停止自动刷新） |
| `TodolistTaskReport.tsx` | cohort（`todolist-quality`）文档渲染：需求映射、plan→todo 保真度、问题分类与评级 |

### 2.1.4 逻辑与数据层 `src/lib/`

**ATIF 契约与投影**（改这里前先读 README 的对应小节与 `tests/steps.test.tsx`）

| 文件 | 作用 |
|---|---|
| `atif.ts` | ATIF v1.8 类型模型 + 校验器（`parseAtifTrajectory`、`AtifValidationError`）；接受 v1.0–v1.8，`requireV18` 可升级为严格校验 |
| `atifToViewer.ts` | **唯一的** ATIF → Viewer 投影（`atifTrajectoryToSteps`）：步骤编号、时间线锚点、agent 归属与委派边、图片解析、工具调用/变更提取 |
| `atifLive.ts` | 实时流契约与合并：记录压缩（丢弃工具进度补丁、step 后写覆盖）、游标推进与 reset 处理、增量 → ATIF 文档物化（含 harness 事件与 desktop timeline） |
| `osworldAtifExtra.ts` | Harness 扩展的解析与校验：`osworld_harness` 的 desktop timeline、planner state、execution-state/v2，以及仅供展示的兼容分支 |
| `plannerState.ts` | `planner-state/v1` 契约与校验（计划节点、轮次预算、task contract） |
| `observerFeed.ts` | 从 Harness 历史里提取 Observer 报告与 Planner 事件；历史缺失时用 `state.*` 快照补一条 |
| `hohState.ts` | HoH 折入：只认已提交的 stage 生命周期记录（plan/verification/invalidation/claims），生成不可变快照序列；模型草稿与未提交参数不算状态 |
| `analysisEvidence.ts` | 分析报告 `turn_id` 证据的去重/排序，供 Turn 链接使用 |
| `analysisJobs.ts` | 作业词表辅助：`isTerminalJob`/`isActiveJob`/`jobPhaseLabel`/`isStaleReport`，读后端发布值，旧后端才回退本地集合 |
| `stepTree.ts` | 按 agent 分组步骤（含环保护），供侧栏树使用 |
| `stepNavigation.ts` | 分析报告的 1-based 全局 Turn → 查看器步骤下标 |

**数据源与传输**

| 文件 | 作用 |
|---|---|
| `ossReplay.ts` | OSS 侧 API 客户端 + 查看器数据组装（643 行）：批次/轨迹/实时流/图片/分析报告请求，实时快照缓存（8 条），执行状态与通过判定映射，媒体 URL 生成 |
| `dataset.tsx` | 数据集仓库：加载内置目录（`dataset.json` + `osworld-v2.dataset.json`）、合并 `localStorage` 上传、按需懒加载 `public/runs/<id>.json`、lookups、聚合与排行榜 |
| `uploadParse.ts` | 浏览器内解析上传 zip（ATIF 与 OpenAI-messages 轨迹），把图片引用解析到 zip 内字节 |
| `cohortReports.ts` | cohort 报告的请求与类型 |
| `aft.ts` | 浏览器内 AFT v1.0 引擎（246 行）：轨迹序列化与截断、提示词构建、直连 Anthropic/OpenAI（浏览器直连头/标志）、报告解析、A/B/C/D 标签表与引擎/模型清单。API key 只存在调用方浏览器（`localStorage`），从不经过后端 |
| `auth.tsx` | 身份钩子：公开构建没有登录，`isMember` 恒为 false（保留调用点，便于将来接真实鉴权） |
| `analytics.ts` | GA4 加载器与页面浏览钩子（`VITE_GA_ID` 未设置时零网络请求） |

**视图模型与工具**

| 文件 | 作用 |
|---|---|
| `stage.ts` | 环境舞台重建（746 行）：按步回放文件系统与终端，识别 shell/python 写文件（heredoc、`tee`、`cp/mv/rm`、`sed -i` 等） |
| `agentfs.ts` | Agent 视角的容器文件系统：按 Dockerfile 的 COPY/WORKDIR 铺开，再叠加运行期 `created/modified/touched` |
| `dockerfile.ts` | Dockerfile / compose 的轻量解释（基础镜像、拷贝、服务、端口） |
| `types.ts` | 归一化领域类型（Task/Run/Step/Agent/Vendor/Grade/HumanLabel…），由 `scripts/ingest.py` 产出 |
| `format.ts` | 展示格式化：时长/百分比/得分/token、JSON 与观察文本美化、状态与家族配色表、模型名美化 |
| `highlight.ts` | highlight.js 核心 + 17 种语言（js/ts/python/bash/json/c/cpp/go/rust/ruby/sql/diff/dockerfile/ini/markdown/xml/yaml） |
| `osworld.ts` | OSWorld 专用小工具：能力标签、`osworldTaskId`（优先读 `metadata.osworld_task_id`） |
| `modelFamily.ts` | 模型/框架 → 厂商家族（展示用，前端唯一分类实现） |
| `tourTask.ts` | 合成"引导任务/运行"夹具：一个覆盖所有渲染器的假任务，供引导与 Showcase 使用 |
| `tour.ts` | driver.js 引导脚本：步骤、选区、切页动作与文案 |

## 2.2 Node 服务

| 文件 | 作用 |
|---|---|
| `server.mjs` | HTTP 服务：静态托管 `dist/`（带哈希资源的长期缓存、SPA 回退、`/healthz`）、`/api/*` 反向代理到 `REPLAY_BACKEND_URL`、优雅关闭。默认监听 `0.0.0.0:18768` |
| `server/proxyApi.mjs` | 代理实现：剥离 hop-by-hop 头、补 `x-forwarded-*`、把客户端中断同时传导给上游请求与响应（避免取消的页面加载留下后台读取）、后端错误转 502 JSON |
| `vite.config.ts` | 开发服务器：`127.0.0.1:5174`，`/api` 代理到 `REPLAY_BACKEND_URL`（默认 18769） |

## 2.3 后端 `backend/`

接口字段、资源上限与运维细节见 [backend/README.md](../backend/README.md)。

**HTTP 与装配**

| 文件 | 作用 |
|---|---|
| `app.py` | ASGI 工厂：`create_app`（依赖注入、错误映射为 `{error:{code,message}}`、`Cache-Control: no-store`）与 `create_oss_app`（真实 OSS 装配 + lifespan 管理同步线程与关闭） |
| `router.py` | 路由分发：参数校验后调用 Service；图片端点限制 MIME 与响应大小；JSON 响应有 64 MiB 上限 |
| `queries.py` | 查询参数契约（Pydantic）：日期/分页/游标/路径与相对路径规则 |
| `services.py` | 共享返回类型与异常（`InvalidQuery`/`ResourceNotFound`/`ServiceUnavailable`/`ImageContent`） |
| `config.py` | `Settings.from_env()`：凭据、路径、并发与容量上限（不可识别的取值直接报错） |

**数据与回放**

| 文件 | 作用 |
|---|---|
| `catalog.py` | `CatalogService`：按日期列批次、批次详情（补评测摘要）、任务执行历史（跨日期 keyset 分页）、排行榜与任务统计（走索引） |
| `replay.py` | `ReplayService`：源格式选择、完整/实时轨迹、切窗、执行状态、图片；实时分块读取与历史重叠恢复就在这里 |
| `artifacts.py` | OSS 布局读取：执行目录约束（`run_dir` 必须在任务目录内）、对象/JSON/行读取与缓存接入 |
| `metadata.py` | 执行摘要归一化：状态、评测状态、agent outcome、得分，以及发布的 `terminal` 与 `passed` |
| `cache.py` | 字节计量的 TTL/LRU 缓存，合并同 key 并发读取 |
| `execution_index.py` | 可重建的 SQLite 摘要索引：过滤条件绑定的 keyset 分页、排行榜聚合、同步状态 |
| `sync.py` | 后台扫描：增量提交批次摘要，绝不读取轨迹或图片；单批次失败保留旧数据 |
| `oss_io/client.py` | 只读 OSS 客户端：urllib + V4 签名（可注入配置/时钟/传输）、分页列举、流式与有界读取、超时语义 |
| `oss_io/file.py` | 有界读取助手（声明大小与实际大小都检查，所有路径都关流） |

**分析（AFT）**

| 文件 | 作用 |
|---|---|
| `native_analysis.py` | `ExecutionAnalysisService`（≈1500 行）：作业编排与并发上限、阶段词表（`JOB_PHASES`）、提示词与 JSON Schema、报告归一化、新鲜度判定与发布、run 级聚合与校验、服务端 Markdown 渲染 |
| `codex.py` | Codex app-server 传输：stdio/JSON-RPC、常驻 worker 复用与回收、模型目录、只读工具的调度与审计 |
| `aft_store.py` | AFT/cohort 的 SQLite：表结构、revision、taxonomy 镜像（含 `INSERT OR IGNORE` 的版本语义）、报告与问题落库、分析缓存 |
| `aft_taxonomy.py` | `lhht/2026-09-07.1` 数据：来源（含权威层级与权重）、8 个节点、每节点的定义/检测信号/排除条件/来源 locator。**唯一实现**，机器与 `/api/problem-tags` 都读它 |
| `aft_atif.py` | 与 harness 扩展解耦的 ATIF 投影：从文档嵌套与 `subagent_trajectory_ref` 确定性重建调用链，供分析使用 |
| `cohort_reports.py` | 独立 cohort 报告的不可变存储（schema 白名单、按 `analysis_type+run_id+revision` 幂等） |
| `evaluator_source.py` | 只读加载 OSWorld evaluator 源码并按 AST 提取被引用的 `metrics/getters` 片段（不执行代码，不写入公开报告） |

**解析器 `backend/parsers/`（纯函数，不访问 OSS/HTTP）**

| 文件 | 作用 |
|---|---|
| `atif_stream.py` | ATIF 步骤/轨迹校验 + 实时清单校验（`descriptors`/`validate_records`/`validate_trajectory`） |
| `legacy_trace.py` | 旧日志 → Agent Work 的纯解析（完整配对后切窗） |
| `legacy_fold.py` | 旧的 work 折叠状态机（轮次编号、工具配对、派发摘要） |
| `legacy_work_helpers.py` | 唯一的 trace 事件解释器：role/origin、图片、全局轮次等辅助解析 |
| `trace_graph.py` | 结构性标注（agent 调用图、控制尾、派发绑定），保持源轨迹无损 |
| `legacy_to_atif.py` | Agent Work → ATIF v1.8，**唯一实现**（前端那份已删除） |
| `execution_state.py` | execution-state/v1 与便携扩展的投影（仅供兼容接口与旧前端） |
| `replay_view.py` | 帧、时间轴、状态与快照更新的纯投影；实时压缩投影（`NativeProjection`） |

`backend/var/`（未跟踪）是运行时状态：`executions.sqlite3`（索引）、`aft.sqlite3`（报告与 taxonomy），
均可重建或重新导入。

## 2.4 数据资产 `public/`

| 路径 | 作用 |
|---|---|
| `public/dataset.json` | 内置样例目录（45 个 Terminal-Bench / Harbor 任务 + 运行与 AFT 引用），由 `scripts/ingest.py` 生成 |
| `public/osworld-v2.dataset.json` | 107 道 OSWorld 2.0 任务（题目、能力标签、难度、源码哈希），由 `scripts/import_osworld.py` 生成 |
| `public/runs/<runId>.json` | 内置运行的轨迹载荷（791 份），打开某个 run 时**懒加载**（保证 `dataset.json` 不膨胀） |
| `public/aft/index.json` + `public/aft/<runId>.json` | 随仓库提供的 35 份 AFT 报告，`/insights` 汇总它们 |
| `public/aft-prompt.md` ⚠️ | 浏览器 AFT 运行时提示词 |
| `public/sample-harbor-task.zip` | `/upload` 页的示例任务包 |
| `public/tour/*.png` | 引导任务用的合成截图（含"已验证"变体） |
| `img/*.png` | 根 README 的功能截图（仅文档用） |

## 2.5 脚本 `scripts/`

| 脚本 | 用途 |
|---|---|
| `ingest.py` | 生成 `public/dataset.json`；把随仓库的审计报告提升到 `public/aft/`；xlsx → `@@SHEET:` 多页签文本 |
| `import_osworld.py` | 从本地 OSWorld-V2 checkout 重建 OSWorld 目录（静态读取，不执行任务代码；失败不替换旧目录） |
| `import_osworld_difficulty.py` | 刷新 `scripts/osworld_difficulty.json` 难度快照（离线、可重复） |
| `import_cohort_report.py` | 把校验过的结构化 cohort 报告导入后端 SQLite（cohort 报告不经 API 写入） |
| `extract_call_graph.py` | 从单个 ATIF v1.8 文件导出确定性的角色调用图（排查用） |
| `test.mjs` | `npm test` 的实现：esbuild 打包前端测试后用 `node --test` 跑，附带代理测试 |
| `rebuild-and-restart.sh` | `npm run deploy` 的实现：`npm ci` → `lint` → `vite build` → 安装并重启两个单元 → 健康检查 |
| `osworld_difficulty.json` | 难度标签快照（数据文件，由上一个脚本刷新） |

## 2.6 测试

**前端**（`npm test`，27 项；由 `scripts/test.mjs` 打包）

| 文件 | 覆盖 |
|---|---|
| `tests/steps.test.tsx` | 前端单元测试主体：实时快照压缩、委派树与折叠、标注/AFT 标记、State 面板投影、analysis 链接、作业词表与新鲜度辅助等；并 import 下面的 HoH 测试 |
| `tests/hoh-state.test.tsx` | HoH 折入：快照不可变、失效不产生 gaps、只认已提交记录 |
| `tests/proxyApi.test.mjs` | 代理的真实 HTTP 回归：完整响应透传、请求体、后端错误、客户端中断传播 |

**浏览器**（需要一个已构建并运行的前端；`REPLAY_TEST_URL` 覆盖地址）

| 文件 | 覆盖 | 是否 mock API |
|---|---|---|
| `tests/steps.browser.mjs`（`npm run test:browser`） | 实时增量下的委派树/折叠、状态跳转、侧栏隐藏、长轨迹定位 | 是 |
| `tests/hoh-state.browser.mjs` | HoH 卡片的播放位置、task items、证据展开、失效与时间跳转 | 是 |
| `tests/liveRecovery.browser.mjs` | 坏掉的实时流报错 → 有效记录到达后自动恢复；断言**不**请求 `/api/agent-work` | 是 |
| `tests/osworld.browser.mjs` | 导入目录与任务页、能力/难度筛选、占位符说明、重载 | 是 |
| `tests/migration.browser.mjs` | 对**真实后端**的只读集成：排行榜、任务历史与筛选、AFT 面板、native/legacy/live 三种轨迹与图片、增量刷新、无 5xx 与浏览器异常 | 否 |

**后端**（`backend/.venv/bin/python -m unittest discover -s backend/tests`，100 项）

| 文件 | 覆盖 |
|---|---|
| `test_services.py` | 服务层：内存 OSS 替身 + 真实解析/SQLite，覆盖历史路径、流游标、重叠恢复、跨窗工具配对、图片摘要 |
| `test_router.py` | HTTP 分发与契约（注入替身 Service，不访问 OSS） |
| `test_stream_compat.py` | 实时清单边界（历史上传布局的接受与拒绝） |
| `test_legacy_compat.py` | 旧折叠语义的合成兼容用例 |
| `test_analysis.py` | AFT 存储与异步服务契约：作业终态/阶段/新鲜度发布、报告结构、taxonomy 版本 |
| `test_aft_atif.py` | 分析用 ATIF 投影：轮次与标准子代理链接 |
| `test_cohort_reports.py` | cohort 报告 schema 隔离与按 revision 不可变 |
| `test_codex.py` | 常驻 Codex worker 池行为 |
| `test_evaluator_source.py` | evaluator 源码只读、有界、不执行 |
| `test_oss_client.py` | OSS 线协议、独立签名向量、有界读取失败 |

**导入器**：`tests/test_import_osworld.py`、`tests/test_osworld_difficulty.py`；
`deploy/test_memory_guard.py` 测内存守护的决策函数。

## 2.7 部署 `deploy/`

| 文件 | 作用 |
|---|---|
| `replay-18768.service` | 生产前端：`node server.mjs`，`REPLAY_HOST=0.0.0.0`、`REPLAY_PORT=18768`、`REPLAY_BACKEND_URL=http://127.0.0.1:18769`，内存上限 384M/512M |
| `replay-backend-18769.service` | 后端：`uvicorn backend.app:create_oss_app`，工作目录 `%h/replay`、索引 `backend/var/executions.sqlite3`、`REPLAY_SYNC_INTERVAL=120`、`REPLAY_EVALUATOR_SOURCE_ROOT=%h/OSWorld-V2`，内存上限 1.5G/2G。单元用 `%h`（服务用户家目录）而不是写死用户名，所以任何位于 `~/replay` 的 checkout 都适用。**该单元名被两个工作树共用**：部署脚本安装自己所在工作树的副本，指到缺少分析模块的树会让 `/api/execution-analysis`、`/api/aft-reports`、`/api/cohort-reports` 消失 |
| `replay-memory-guard.py` + `replay-memory-guard.service` + `replay-memory-guard.timer` | 主机内存守护：每 5 秒采样，≥80% 停掉 `REPLAY_GUARD_UNITS`（本机经 drop-in 覆盖为 18768 + 18767 + 18769），低于 75% 持续 60 秒才恢复，≥85% 额外打 critical |
| `test_memory_guard.py` | 守护决策函数的单元测试 |
| `README-memory-guard.md` | 上述守护的操作手册 |

## 2.8 根配置与构建链

| 文件 | 作用 |
|---|---|
| `package.json` | 脚本入口：`dev` / `build` / `lint` / `test` / `test:browser` / `preview` / `start` / `deploy` |
| `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` | 项目引用；`app` 覆盖 `src`（`strict` + `noUnusedLocals`，即 `npm run lint`），`node` 覆盖构建脚本 |
| `tailwind.config.js` / `postcss.config.js` | Tailwind 主题：`ink` 背景阶梯、`line`/`code`/`accent` 色板、Inter/等宽字体栈、`darkMode: 'class'`；PostCSS 管线 |
| `vercel.json` | Vercel 部署时的 SPA 重写（除 `api/`、`assets/`、`aft/` 与静态文件外都回退到 `index.html`） |
| `.env.example` | 前端构建期变量模板：`VITE_GA_ID`、`VITE_REPLAY_API_BASE` |
| `.gitignore` | 忽略 `node_modules/`、`dist*/`、`.venv/`、`__pycache__/`、`data/`、`.claude/`；`backend/var/` 由 `backend/.gitignore` 忽略 |
| `LICENSE` / `NOTICE` | Apache-2.0 与上游归属（上游是 ATIF Trajectory Viewer，见根 README 末尾） |

---

# 三、运行与排障

## 3.1 前置

- Node 22（`package.json` 未锁 engines，实测 v22）。
- Python 3.10+（实测 3.12）。后端运行时依赖仅 `fastapi`/`pydantic`/`uvicorn`；
  开发测试额外需要 `httpx`。

## 3.2 本机开发

```bash
npm install
npm run dev            # http://127.0.0.1:5174/live
```

Vite 把 `/api` 代理到 `REPLAY_BACKEND_URL`（默认 `http://127.0.0.1:18769`）。
后端单独启动（需要 `OSS_*` 配置）：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
backend/.venv/bin/python -m uvicorn backend.app:create_oss_app \
  --factory --host 127.0.0.1 --port 18769
```

只调前端、不连后端时，页面显示等待/失败提示而不会崩溃；多数浏览器套件自 mock API。

## 3.3 构建、启动与部署

```bash
npm run lint           # tsc --noEmit
npm run build          # tsc + vite build -> dist/
npm run start          # node server.mjs（默认 0.0.0.0:18768）
npm run deploy         # 构建 + 安装/重启 systemd 单元（18768 与 18769）
```

端口：

| 端口 | 用途 |
|---|---|
| 5174 | Vite 开发服务器 |
| 18768 | 生产前端（Node：静态 + `/api` 代理） |
| 18769 | 本仓库后端（只监听 127.0.0.1） |
| 18767 | 旧 `oss-replay` 服务，仍在运行，Replay 不再使用它 |

部署要点：单元里的路径都用 systemd 的 `%h`（服务用户家目录），因此
`deploy/replay-backend-18769.service` 指向的是 `%h/replay`——承载后端的那个 checkout，
指到缺少分析模块的树会让分析接口消失；OSS 凭据来自
`EnvironmentFile=%h/.config/replay-migration/oss.environment`；索引
`backend/var/executions.sqlite3` 可重建。改后端资源上限需要
`systemctl --user restart replay-backend-18769.service`；仅改前端不需要重启后端。
完整运维说明见 [backend/README.md](../backend/README.md) 的「部署与运维」。

## 3.4 环境变量

- 前端构建期（仅 `VITE_` 前缀进产物）：`VITE_GA_ID`、`VITE_REPLAY_API_BASE`。
- Node 代理：`REPLAY_BACKEND_URL`、`REPLAY_HOST`、`REPLAY_PORT`、`REPLAY_STATIC_ROOT`。
- 后端：`OSS_*` 六个连接项 + `REPLAY_*`（索引路径、同步间隔、并发、缓存、AFT 路径与并发、
  evaluator 根目录等），完整表见 `backend/README.md`。

## 3.5 测试与校验

```bash
npm test                                                              # 27 项
npm run lint
npm run build
backend/.venv/bin/python -m unittest discover -s backend/tests        # 100 项
python3 -m unittest discover -s tests -p 'test_*osworld*.py'          # 10 项
npx playwright install chromium && npm run test:browser               # 首次装 chromium
node tests/{hoh-state,liveRecovery,osworld,migration}.browser.mjs     # 其余套件
```

## 3.6 常见问题

| 现象 | 原因与处理 |
|---|---|
| 回放页"等待中/失败，重试中" | 该执行既没有终态 ATIF 也没有已发布的实时流；等下一轮轮询，不要期待前端回退到旧格式 |
| OSWorld 任务历史为空 | 后端索引仍在 `syncing`（首扫约 30–40 秒）或同步失败；页面会显示同步状态 |
| `/api` 返回 502 | 后端没起或崩了：`systemctl --user status replay-backend-18769.service` |
| 服务被自动停掉 | 主机内存守护触发（≥80%）：`python3 ~/.local/bin/replay-memory-guard.py --status`，恢复条件见 `deploy/README-memory-guard.md` |
| 改了分析提示词没生效 | 提示词来自 `skills/*/SKILL.md` 与 `public/aft-prompt.md`，改的是运行时行为，需重启后端/刷新页面 |
| 页面上数据像是旧版本 | 先看前端构建时间；`npm run deploy` 会重新构建并重启 |

---

# 四、改代码前必读

## 4.1 任务索引：想做什么 → 看哪里

| 想做的事 | 先看 |
|---|---|
| 加 / 改一个页面 | `src/App.tsx`（路由）→ `src/pages/` → 导航在 `src/components/Layout.tsx` |
| 改轨迹怎么显示 | `src/lib/atifToViewer.ts`（唯一投影）→ `src/components/StepTimeline.tsx` / `EnvironmentStage.tsx` |
| 改环境舞台或文件系统推断 | `src/lib/stage.ts`、`src/lib/agentfs.ts`、`src/lib/dockerfile.ts` |
| 改 State 面板（Planner / Observer / HoH） | `src/lib/observerFeed.ts`、`plannerState.ts`、`hohState.ts` → `src/components/ExecutionStatePanel.tsx` |
| 加一个后端接口 | `backend/queries.py`（契约）→ `backend/router.py`（分发）→ Service（`catalog.py` / `replay.py` / `native_analysis.py`）→ `backend/tests/test_router.py` |
| 改前端如何取数 | `src/lib/ossReplay.ts`（唯一的 OSS 侧客户端）；不要在页面里直接 fetch |
| 改分析报告口径 | `skills/*/SKILL.md` 与 `backend/native_analysis.py` 里的提示词、Schema 与校验 |
| 改 taxonomy 节点 | `backend/aft_taxonomy.py`；**同时 bump `TAXONOMY_VERSION`**，否则已存报告会被判成"仍然有效" |
| 改文件渲染器 / 新文件类型 | `src/components/FileRenderer.tsx`（+ `ArcGrid.tsx`、`CodeBlock.tsx`） |
| 改样式与主题 | `tailwind.config.js` 色板 + `src/index.css` |
| 改上传解析 | `src/lib/uploadParse.ts`（内置数据的对应物是 `scripts/ingest.py`） |
| 改引导 tour | `src/lib/tour.ts` + `src/lib/tourTask.ts` |
| 排查回放为空 | 本文 3.6；后端 `ReplayService._load_view` 的来源选择 |
| 排查任务历史为空 | 索引同步：`backend/sync.py`、`backend/execution_index.py` |
| 排查分析作业不动 | `backend/codex.py`（worker 池与模型目录）+ `native_analysis.py` 的作业状态发布 |
| 部署 / 改端口 / 改内存上限 | `deploy/*.service`、`scripts/rebuild-and-restart.sh`、`backend/README.md` 的部署与运维 |

## 4.2 不要复活已删除的重复实现

它们曾是真实的双实现风险：

- Node 侧 OSS 读取器（`server/atifLive.mjs`、`server/bufferCache.mjs`）——后端是唯一的 OSS 读取者；
- 前端旧格式转换器（`src/lib/legacyTraceToAtif.ts`）——后端 `legacy_to_atif.py` 是唯一实现；
- 前端的构建模式开关（`VITE_REPLAY_BACKEND_MODE` / `standaloneBackend`）——只有一条数据路径；
- Python 侧与生产重复的分块装配函数——实时恢复只在 `ReplayService._stream` 里实现。

## 4.3 已知限制

1. **没有鉴权**：所有页面与接口对访问者开放，包括会启动 Codex 作业的
   `POST /api/execution-analysis`、`POST /api/run-analysis`；部署边界目前只有网络层。
2. **人工标注不持久**：Label/Note 只存在当前页面会话（`HumanLabel` 无 localStorage、无服务端）。
3. **上传数据只在本机**：`localStorage`（`tv-uploads`），换浏览器或清站点数据即消失。
4. **环境舞台是推断**：容器文件系统与文件状态由轨迹里的工具调用重建，不保证与真实容器一致。
5. **兼容接口保留**：`/api/agent-work`、`/api/model-image`、`/api/execution-state` 已无当前
   前端消费者，仅为已停止的迁移前端保留；`/api/window` 后端有实现但前端不使用。
6. **迁移测试已退役**：18770 前端、它的单元文件、`dist-migration/` 与
   `replay-backend-migration` 工作树都已删除，只剩一条 TCP 18770 安全组入站规则
   需要在云控制台手工清理。
7. **旧服务仍在跑**：`oss-replay-18767.service` 与本仓库无关，但仍占资源并列入内存守护；
   退役它需要从守护的 `REPLAY_GUARD_UNITS` 里移除。

## 4.4 改代码自检

- 改前端数据路径：确认没有绕过 `ossReplay.ts` 的 `fetchViewerBundle` 去读第二种表示。
- 改后端响应：新增/改名判定字段时同步本文与 `backend/README.md`，并给
  `backend/tests/test_analysis.py` 加断言。
- 改提示词或技能：没有自动化测试覆盖分析质量，改完至少手动跑一次
  `POST /api/execution-analysis`，确认报告结构仍符合前端渲染契约
  （字段见 `BackendExecutionAnalysis.tsx` 的两个 schema 校验函数）。
- 改部署：`deploy/replay-backend-18769.service` 必须指向承载后端的树；`npm run deploy`
  会安装并重启两个单元。

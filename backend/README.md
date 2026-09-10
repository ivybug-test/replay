# Replay 独立 OSS 后端

已实现 OSS 客户端、Router、CatalogService、ReplayService，以及它们依赖的
产物定位、缓存、执行索引、后台同步和轨迹解析。后端只读 OSS；任务说明、能力标签、
难度仍由前端维护。运行时不依赖 harness 或旧 oss-replay 的代码目录。

本后端服务 18768 生产前端的 `/api`（18770 迁移测试前端已停止并从单元中禁用）。
前端 Node 进程不持有 OSS 凭据，所有 `/api` 请求（含 `/api/atif-live`）都转发到此
服务。后端监听本机 18769。
Python 3.10+；OSS、索引和解析层使用标准库，HTTP 层使用 FastAPI/Pydantic/Uvicorn。

## 启动

从项目根目录执行：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
# 先在环境中提供 OSS_* 配置，再启动实际服务：
backend/.venv/bin/python -m uvicorn backend.app:create_oss_app --factory --host 127.0.0.1 --port 18769
```

正式运行只需安装 `backend/requirements.txt`。入口读取环境变量，不自动读取其他
项目的 `.env`。也可在 Python 中传入 `Settings`，或自行装配并调用
`create_app(catalog=..., replay=...)`。不注入 Service 的 `create_app` 仍可用于
Router 调试：health/docs 可用，业务接口返回 503。

OSS 配置：`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、
`OSS_ENDPOINT`、`OSS_REGION`、`OSS_PREFIX`。endpoint/region 默认与 harness
一致，为河源内网 HTTPS 地址和 `cn-heyuan`；根目录为 `<OSS_PREFIX>/harness/`。
不回退到 VM 控制使用的 `ALIYUN_*` 凭据。

## 部署与运维

生产环境由两个用户 systemd 单元组成：`replay-18768.service`（Node 静态托管 + `/api`
代理）与 `replay-backend-18769.service`（本后端）。`npm run deploy`
（`scripts/rebuild-and-restart.sh`）构建前端并安装、重启两个单元。

- 单元文件在 `deploy/`，由部署脚本从它所在的工作树安装。因此
  `replay-backend-18769.service` 必须指向承载本后端的树（`/home/binqiu/replay`）：
  其他工作树可能缺少分析模块，切过去会让 `/api/execution-analysis`、
  `/api/aft-reports`、`/api/cohort-reports` 消失。
- OSS 凭据通过 `EnvironmentFile=/home/binqiu/.config/replay-migration/oss.environment`
  提供：mode 0600，只含六个 `OSS_*` 值，从既有的授权配置整理而来，不含模型或
  VM 管理凭据，不要提交。
- 索引 `backend/var/executions.sqlite3`（可重建，绑定 bucket/endpoint/prefix），
  扫描间隔 120 秒；`REPLAY_EVALUATOR_SOURCE_ROOT=/home/binqiu/OSWorld-V2` 同时写进
  单元与环境导入，手动重启不会丢失 evaluator 上下文。
- 旧 `oss-replay` 服务（18767）仍在运行，但 Replay 不再调用它。主机内存守护通过
  `~/.config/systemd/user/replay-memory-guard.service.d/migration.conf` 覆盖
  `replay-18768`、`oss-replay-18767`、`replay-backend-18769` 三个单元，见
  `deploy/README-memory-guard.md`。
- 待清理：已停止的迁移测试前端（18770）留下一条 TCP 18770 安全组入站规则；它的
  单元文件与 `dist-migration/` 也可以删除。

## 环境变量

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `REPLAY_INDEX_PATH` | `backend/var/executions.sqlite3` | 可重建的执行摘要索引 |
| `REPLAY_SYNC_INTERVAL` | 60 | 每次扫描完成后的等待秒数 |
| `REPLAY_OSS_TIMEOUT` | 10 | 单次阻塞 OSS I/O 的超时秒数 |
| `REPLAY_READ_CONCURRENCY` | 4 | 同时进行的 OSS 读取数 |
| `REPLAY_CONCURRENCY` | 2 | 同时解析回放的数量 |
| `REPLAY_LIVE_TTL` | 2 | 可变产物及回放视图的缓存秒数 |
| `REPLAY_OBJECT_MIB` | 64 | 单产物、旧流或帧事件集合的读取上限 |
| `REPLAY_READ_CACHE_MIB` | 32 | 原始对象缓存容量 |
| `REPLAY_CACHE_MIB` | 64 | 解析后回放视图缓存容量 |
| `REPLAY_AFT_PATH` | `backend/var/aft.sqlite3` | AFT/cohort 报告与 taxonomy 的 SQLite |
| `REPLAY_AFT_WORKERS` | 20 | 共享的 Codex 分析并发上限（最大 24） |
| `REPLAY_EVALUATOR_SOURCE_ROOT` | 未设置 | 只读的 OSWorld evaluator 源码仓库 |

生产环境覆盖了其中两项（`REPLAY_SYNC_INTERVAL=120`、索引路径），见「部署与运维」。

目录列表缓存 10 秒，目录查询结果缓存上限 8 MiB。不可变分块/帧事件缓存 1 小时，
仍受容量和条目数限制；缓存按 Python 容器实际占用估算，采用 TTL/LRU 淘汰并合并
相同 key 的并发读取。超大对象不会驻留缓存。图片读取/响应上限 32 MiB，JSON 响应
上限 64 MiB；原生实时响应按约 8 MiB 的分块读取量分页（单个大分块仍受单产物
上限限制），`has_more` 表示还需继续读取，下一次 after 使用实际已消费的行数。
原生时间轴投影逐块读取、仅保留最新步骤，累计扫描预算为单产物上限的 8 倍；
缓存的是投影结果。元数据文档上限 8 MiB，轨迹记录最多 100 万条、分块最多 1 万个、
桌面帧最多 2 万张。内存限制是各组件预算，不是整个进程 RSS 的硬上限。

## 目录和职责

```text
backend/
├── app.py / router.py / queries.py   # 组装、生命周期、路由、参数校验
├── services.py                      # 公共返回类型和异常
├── config.py                        # 配置和资源限制
├── catalog.py                       # 日期批次、批次详情、任务执行历史
├── replay.py                        # 完整/实时轨迹、窗口、执行状态和图片
├── artifacts.py                     # OSS 布局和执行目录约束
├── metadata.py                      # 状态、评分、终态、通过判定和执行摘要
├── cache.py                         # TTL/LRU、容量和相同请求合并
├── execution_index.py / sync.py      # SQLite 摘要索引和后台扫描
├── oss_io/                          # V4 签名、分页列表、流式与有界读取
├── native_analysis.py               # AFT 作业编排、阶段词表、报告与新鲜度发布
├── codex.py                         # Codex app-server 传输（stdio/JSON-RPC、模型目录）
├── aft_store.py                     # AFT/cohort 的 SQLite 表、revision、taxonomy 与缓存
├── aft_taxonomy.py                  # lhht taxonomy 数据（版本、节点、来源与权重）
├── aft_atif.py                      # 分析用 ATIF 投影与调用链重建
├── cohort_reports.py                # 独立 cohort 报告的不可变存储
├── evaluator_source.py              # 只读 evaluator 源码加载与符号提取
├── parsers/                         # 纯解析和转换，不访问 OSS/HTTP
│   ├── atif_stream.py               # ATIF/实时清单校验
│   ├── legacy_trace.py              # 旧日志 → Agent Work，完整配对后切窗
│   ├── legacy_fold.py               # 沿用旧 Replay 的事件折叠语义
│   ├── legacy_work_helpers.py       # 事件、图片、全局轮次辅助解析
│   ├── trace_graph.py               # 代理图和调用关系标注
│   ├── legacy_to_atif.py            # Agent Work → ATIF v1.8（唯一实现）
│   ├── execution_state.py           # execution-state/v1 与便携扩展的投影
│   └── replay_view.py               # 帧、时间轴、状态和快照更新
└── tests/
```

## CatalogService

- `list_runs(date=None)`：按日期列出已发布批次；不指定日期时选择最近有有效
  `batch.json` 的日期。只列出了目录但尚未发布元数据的批次不计入结果。
- `get_batch(run=...)`：读取批次与各次执行的 `result.json`，补充评测摘要。
  `(batch_id, task_key)` 唯一标识一次执行，`task_id` 保留三位数字。
- `list_task_runs(task_id=..., cursor=None, limit=50, model=None, status=None)`：
  查询索引中的跨日期历史。按 batch_id、task_key 倒序进行 keyset 分页，游标绑定
  索引与筛选条件。`status` 筛选执行状态；模型缺失返回 null，不根据 runtime 名称猜测。

执行状态、评测状态、agent outcome 和 score 分开保存，评分缺失为 null，0 分为 0。

启动后后台分页扫描 OSS 批次，只读取批次/结果摘要，不下载轨迹或图片。
每个批次原子替换索引，单个批次失败时保留其旧数据；只有完整成功扫描才删除 OSS
已移除的批次。同步响应包含 `status`、`last_success`、已扫描/失败批次数和错误类型。
首次建立为 pending/syncing，重启为 stale，失败为 failed，完成为 ready；空列表须
结合同步状态解释。索引绑定 bucket/endpoint/prefix，不能误用其他 OSS 位置的历史。

索引可通过停止后端、移走 SQLite 文件及其 WAL/SHM 文件再重启来重建。
单进程实例默认拥有一个同步线程；多实例部署应各自使用索引路径。

## ReplayService

- `get_trajectory(run, task)`：优先读取原生完整 ATIF（依次尝试执行根目录、
  `agent/`、`runtime-artifacts/`）。旧日志在后端经 Agent Work 转为 ATIF v1.8。
  仅有原生实时流时，此接口返回 404，由客户端使用 live 接口。返回前会补齐 Harness
  run 元数据与桌面时间轴；生产者自带的 `extra.osworld_execution_state` 原样保留，
  只有本身没有该扩展的来源（旧日志转换结果）才会由后端写入投影，避免用只覆盖部分
  事件类型的投影覆盖生产者文档。
- `get_atif_live(run, task, after=0)`：原生流按清单读取尚未消费的分块，返回
  `start_line`、`total_lines`、`records`、`terminal` 和 `stream`。游标超过源长度时
  从 0 重置；历史上传器的重叠分块只在重复记录及序号一致时去重，超过发布游标
  的尾部不输出。公布的分块缺失、冲突或清单有间隙返回上游错误。
  旧轨迹使用 ATIF 快照更新，`start_line=0`、`stream.reset=true`，客户端必须替换
  旧记录。这让未完成工具调用可以更新，不会产生伪造的追加游标。
- `get_window(...)`：按 episode 时间切窗，返回窗口记录、完整语义步骤 `steps`、
  桌面帧，并保留窗口开始前最后一帧。`steps` 的每项包含 trajectory_id 和 step，
  原生实时工具补丁先合并再切窗。可附全局 agent/desktop 时间轴；旧格式额外返回
  已配对的窗口 `work`。只有帧、尚无 agent 步骤时仍可返回桌面窗口。
- `get_execution_state(run, task)`：读取原生 ATIF 扩展、实时状态补丁或旧日志中的
  execution-state 事件，返回统一事件列表、分类计数及已有的 final_state。
- `get_frame(run, task, frame)`：按桌面帧索引读图。
- `get_model_image(run, task, path, sha256)`：读取旧模型图片并校验 SHA-256。
- `get_atif_media(run, task, path)`：读取 ATIF 引用的图片，兼容历史文档目录；
  以 SHA-256 命名的图片会核对摘要。图片检查文件签名，支持 PNG/JPEG/WebP/GIF。
- `get_agent_work(...)`：过渡兼容接口。旧格式先配对完整工具调用，再切窗；
  原生 ATIF 不反向转换成 Agent Work。已停止的迁移前端仍会调用它，因此保留；
  当前 Replay 前端不再请求该接口。

支持批次元数据中的 `run_dir`，且路径必须处于该任务目录内。旧日志支持完整
`runtime-trace.jsonl`、`runtime-artifacts/runtime-trace.jsonl`、v2 分块尾流和早期滚动尾流。
完整日志优先于尾流；滚动尾流保留已知的 trace coverage 起点。

## OSS 数据布局

```text
<OSS_PREFIX>/harness/<batch_id>/
├─ batch.json
└─ tasks/<task_key>/
   ├─ trajectory.json
   ├─ agent/trajectory.json                 # 其他已支持的轨迹位置
   ├─ runtime-artifacts/trajectory.json
   ├─ trajectory-tail.meta.json
   ├─ trajectory-tail.jsonl.chunks/
   ├─ runtime-artifacts/runtime-trace.jsonl # 历史格式
   ├─ trace-tail.meta.json
   ├─ trace-tail.jsonl 或其分块目录
   ├─ replay/meta.json
   ├─ replay/events/
   ├─ replay/frames/
   ├─ run_state.json
   └─ result.json
```

上述文件并非每次执行都会同时存在，执行目录也可能按批次元数据中的 `run_dir` 约定
变化。实验发现与执行历史查询只读批次与结果摘要，不扫描轨迹、截图或图片字节；
没有截图的合法执行同样会被发现。

前端直接消费统一 ATIF，实时增量合并在浏览器中完成；旧版日志由本后端归一化为
ATIF，前端不再执行 Agent Work → ATIF 转换，也不再回退到 `/api/agent-work`：
旧格式存档的可视性完全由本后端保证（`legacy_to_atif` 是唯一实现，前端那份已随
迁移删除），因此前端没有构建模式开关，只有一条数据路径。

## HTTP 接口

`GET /api/health` 报告进程可响应、各 Service 是否注入，不代表 OSS 已连通或
索引同步完成。`/api/docs` 和 `/api/openapi.json` 提供接口和参数定义。

| GET 路径 | 查询参数 |
|---|---|
| `/api/runs` | 可选 `date`：YYYY-MM-DD |
| `/api/leaderboard` | 可选 `date_from`、`date_to`、`include_smoke`；按唯一 task coverage 优先、task 等权平均分其次排名；同一模型同一 task 的多次运行先求均值 |
| `/api/task-stats` | 官方 OSWorld 2.0 107 个任务的全量 run、评分、通过率与最近执行汇总 |
| `/api/batch` | `run`；返回 `{ "batch": ... }` |
| `/api/task-runs` | 三位 `task_id`；可选 `cursor`、`limit`（1–100）、`model`、`status` |
| `/api/trajectory` | `run`、`task` |
| `/api/atif-live` | `run`、`task`、可选 `after` |
| `/api/agent-work` | `run`、`task`、可选 `center_ms`、`before_ms`、`after_ms` |
| `/api/window` | 同上，另可选 `include_timeline` |
| `/api/execution-state` | `run`、`task` |
| `/api/frame` | `run`、`task`、`frame` |
| `/api/model-image` | `run`、`task`、相对 `path`、`sha256` |
| `/api/atif-media` | `run`、`task`、相对 `path` |
| `/api/analysis-models` | 返回当前分析后端支持的模型列表和默认模型 |
| `/api/execution-analysis` | `run`、`task`；读取后端原生 ATIF task 报告与作业状态 |
| `/api/run-analysis` | `run`；读取整个 run 的 AFT 报告与作业状态 |
| `/api/run-analysis-statuses` | 返回各 run 最新的 AFT 作业与报告状态 |
| `/api/aft-reports` | 返回已完成的 run 报告列表 |
| `/api/aft-reports/{report_id}` | 返回一个完整 run 报告 |
| `/api/cohort-reports` | 返回最新的独立 cohort 报告列表 |
| `/api/cohort-reports/{report_id}` | 返回一个不可变 revision 的 cohort 报告 |
| `/api/problem-tags` | 返回当前版本的 source-grounded taxonomy、规范化定义、映射条件、排除条件与逐节点原文出处 |

`POST /api/execution-analysis` 接受 JSON `{ "run": "...", "task": "...", "model": "...", "force": false }`，
仅为终态 Execution 幂等地启动或复用分析作业；`POST /api/run-analysis` 接受
`{ "run": "...", "model": "...", "force": false }`，为终态 run 启动固定的 task-first 分析流程。
`model` 可省略，值必须来自
`GET /api/analysis-models`；Run 的 `force=true` 重新聚合并创建可与旧版并存的新 revision，仍复用当前有效的单任务报告；单任务本身需要重跑时使用对应 Execution 的 `force=true`。

作业状态、阶段词表与报告新鲜度由后端判定并随响应发布，调用方不再自行猜测：

- 每个 job 返回 `status`、`terminal`、`phase` 与 `phase_label`。`terminal` 是唯一的终态
  判定；`phase` 取自固定阶段表（`queued`、`preparing`、`evidence-collection`、
  `finalizing-report`、`task-analysis`、`common-problem-synthesis`、`completed`、`failed`、
  `cancelled`），`phase_label` 是它对应的展示文案。
- task 与 run 报告返回 `current`：`true` 表示这份 revision 对产出它的模型仍然有效，
  `false` 表示 pipeline、taxonomy、evaluator 摘要或（run 层）run 组成已变化，`null`
  表示暂时无法判定（例如 OSS 不可用）。列表接口用不含 run 组成检查的轻量判定，因此
  不读 OSS；`run_state` 会用完整判定。前端据此决定是否 `force`，不再以“有没有报告”代替。
- `/api/analysis-models` 在每一项上返回 `hidden`。被隐藏的模型是产品可见性策略，仍可按
  名称选用，以便用产出旧报告的模型重跑，不会因为目录更新而无法复用历史报告。

`/api/execution-state` 只服务旧的 execution-state/v1 事件族，Replay 的 State 面板不再
读取它：面板只消费轨迹 Harness 扩展里的 `planner_state`、`observer_interval` 与
`subagent_lifecycle`。

Cohort Report 与普通 AFT run/task report 使用同一 SQLite 文件中的独立表。公网 API
保持只读；分析完成后使用 `scripts/import_cohort_report.py` 导入经过验证的结构化 JSON
与 Markdown。相同 `analysis_type + run_id + revision` 不可变：同内容重复导入幂等，
不同内容会失败，新内容必须使用更高 revision。

分析过程直接读取 ATIF 1.8 core 字段，并从 `subagent_trajectories` 与 `subagent_trajectory_ref`
确定性重建与 harness 扩展字段解耦的调用链。Task Analyzer 在单个持续 Turn 中主动调用只读工具，生成包含结论、主要问题、调用关系、执行阶段、每个 Turn 和 evaluator 分析的独立报告。
Run Analyzer 的固定编排先并发处理全部终态 task：当前模型与 pipeline 的已有 task 报告会直接复用，缺失或过期的报告才重新生成；全部 task 处理结束后，第二阶段只能分页读取这些单任务报告，先归纳至少跨两个 task 的共性机制，再读取 taxonomy 做可选映射。后端拒绝虚构 task、虚构单任务问题标题、singleton “共性问题”和不存在的 taxonomy ID。Run 报告固定包含 Task 评分表格与共性问题分析，每个共性问题引用 1–3 个典型 task。

当前 taxonomy 是 `lhht/2026-09-07.1` 的 8 个核心长程 harness 问题节点，来自近六个月论文、活跃项目和权威组织原文的后置聚类；中文与英文规范化标签均明确属于编辑性综合。每个节点保留原始来源、精确章节链接、轨迹映射所需证据和排除条件；HarnessRisk 只支撑持久状态安全与动作授权节点，不用于一般能力、进度或可靠性问题。
轨迹缺口记录为 `analysis_input_quality`，不算作 Agent 问题。Codex worker 运行在临时目录中，只开放 AFT 动态只读工具和实时网页搜索，关闭
shell、浏览器自动化、插件和工作区写入。常驻 app-server worker 在调用之间复用，并在整个 run 完成后释放。Task agentic 结果
按轨迹哈希、模型、pipeline 及 taxonomy 版本缓存。task 与 run 报告、问题证据和 taxonomy 存入
`REPLAY_AFT_PATH` 指定的 SQLite（默认 `backend/var/aft.sqlite3`）；
`REPLAY_AFT_WORKERS` 控制共享的 Codex 并发上限。单 Task 2 分钟、整个 Run 15 分钟是性能目标，不是硬性墙钟或失败条件。
Run 的单任务报告生成受 `REPLAY_AFT_WORKERS` 有界并发控制。Analyzer 会继续到正常完成、App Server 明确报错或收到用户取消；超过性能目标只记录为慢，不会强制终止。

`REPLAY_EVALUATOR_SOURCE_ROOT` 可配置只读的 OSWorld evaluator 源码仓库。AFT 在 episode 结束后按
`task_id` 加载对应 `evaluation_examples/task_class/task_<id>.py`，并静态提取其引用的通用
`metrics/getters` 函数，用于分解评分项和定位丢分；源码不会提供给被评判的执行 Agent，也不会写入公开报告。
Analyzer 不得建议向 Agent 暴露 evaluator、gold、隐藏权重或断言，也不得据此生成针对隐藏实现的优化建议。

`center_ms=-1` 表示结尾；window 默认前 30000 / 后 60000 ms。
显式跨度须在 5000–120000 ms 内。路径拒绝绝对路径、URL、`.`/`..`、反斜杠和控制
字符；不二次解码。所有资源访问限定在对应执行目录内。

错误统一为 `{ "error": { "code": "...", "message": "..." } }`：参数格式错误 422，
语义无效查询/游标 400，执行或产物缺失 404，未注入 Service 503，上游失败/无效
产物/超限 502，上游超时 504，未预期异常 500。不会将原始异常正文输出到浏览器。
响应采用 `Cache-Control: no-store`。

## OSS 底层接口

底层参考 harness 的 urllib/V4 签名实现，保留凭据、时钟和传输注入。

- `OssClient.get_object(key, if_none_match=...)`：返回可关闭的 `ObjectStream`
  或 `NotModified`。保留 size/ETag/Last-Modified/Content-Type 和原始响应头。
- `list_objects(prefix, delimiter=..., cursor=..., limit=...)`：一次 ListObjectsV2，
  返回对象、目录前缀与下一页游标。上层必须遍历所有页，重复游标视为错误。
- `oss_io.file.read_bytes(client, key, max_bytes=...)`：检查声明和实际大小，任何
  成功/失败/超限路径都关闭响应流。

底层不重试、不缓存。404 NoSuchKey 与桶不存在/权限失败分开处理；关闭环境代理和
自动重定向。timeout 为阻塞 I/O 超时，并非整个多对象请求的总时限。当前不设自动
重试，多对象首次回放仍可能较慢；缓存及并发控制在上层。

## 验证

```bash
backend/.venv/bin/python -m unittest discover -s backend/tests -v
```

测试覆盖 OSS 签名固定向量/本地 HTTP、全部路由分发、真实 Service 组装、历史路径、
索引同步失败/重启/分页、零分/null、流游标、缺失分块、工具跨窗配对、图片摘要、
缓存淘汰和原有旧 Replay 的合成兼容用例。自动测试不读取真实凭据、不访问 OSS。

2026-09-04 只读抽样验证：索引扫描 194 个已发布批次，无失败；任务 003 查到
60 次执行、覆盖 10 个日期。原生实时流、完整 ATIF、旧日志、桌面图片读取通过。
旧日志代表样本转换出的 21 步 ATIF 与当时的 TypeScript 转换器输出一致（该前端
转换器随后已删除，`legacy_to_atif` 是唯一实现）；旧版转换结果和原生完整文档均
通过前端 ATIF 校验。没有上传对象或切换现有服务。

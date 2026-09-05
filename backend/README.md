# Replay 独立 OSS 后端

已实现 OSS 客户端、Router、CatalogService、ReplayService，以及它们依赖的
产物定位、缓存、执行索引、后台同步和轨迹解析。后端只读 OSS；任务说明、能力标签、
难度仍由前端维护。运行时不依赖 harness 或旧 oss-replay 的代码目录。

现有前端代理尚未切换。本目录提供可单独运行的新后端，默认开发端口 18769。
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

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `REPLAY_INDEX_PATH` | `backend/var/executions.sqlite3` | 可重建的执行摘要索引 |
| `REPLAY_SYNC_INTERVAL` | 60 | 每次扫描完成后的等待秒数 |
| `REPLAY_OSS_TIMEOUT` | 10 | 单次阻塞 OSS I/O 的超时秒数 |
| `REPLAY_READ_CONCURRENCY` | 4 | 同时进行的 OSS 读取数 |
| `REPLAY_CONCURRENCY` | 2 | 同时解析回放的数量 |
| `REPLAY_LIVE_TTL` | 2 | 可变产物及回放视图的缓存秒数 |
| `REPLAY_OBJECT_MIB` | 64 | 单产物、单次流分块合计或帧事件集合的读取上限 |
| `REPLAY_READ_CACHE_MIB` | 32 | 原始对象缓存容量 |
| `REPLAY_CACHE_MIB` | 64 | 解析后回放视图缓存容量 |

目录列表缓存 10 秒，目录查询结果缓存上限 8 MiB。不可变分块/帧事件缓存 1 小时，
仍受容量和条目数限制；缓存按 Python 容器实际占用估算，采用 TTL/LRU 淘汰并合并
相同 key 的并发读取。超大对象不会驻留缓存。图片读取/响应上限 32 MiB，JSON 响应
上限 64 MiB；元数据文档上限 8 MiB，轨迹记录最多 100 万条、分块最多 1 万个、
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
├── metadata.py                      # 状态、评分和执行摘要
├── cache.py                         # TTL/LRU、容量和相同请求合并
├── execution_index.py / sync.py      # SQLite 摘要索引和后台扫描
├── oss_io/                          # V4 签名、分页列表、流式与有界读取
├── parsers/                         # 纯解析和转换，不访问 OSS/HTTP
│   ├── atif_stream.py               # ATIF/实时清单校验
│   ├── legacy_trace.py              # 旧日志 → Agent Work，完整配对后切窗
│   ├── legacy_fold.py               # 沿用旧 Replay 的事件折叠语义
│   ├── legacy_work_helpers.py       # 事件、图片、全局轮次辅助解析
│   ├── trace_graph.py               # 代理图和调用关系标注
│   ├── legacy_to_atif.py            # Agent Work → ATIF v1.8
│   ├── execution_state.py           # 新旧执行状态投影
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
  仅有原生实时流时，此接口返回 404，由客户端使用 live 接口。
- `get_atif_live(run, task, after=0)`：原生流按清单读取尚未消费的分块，返回
  `start_line`、`total_lines`、`records`、`terminal` 和 `stream`。游标超过源长度时
  从 0 重置；公布的分块缺失、内容不符或清单有间隙返回上游错误。
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
- `get_agent_work(...)`：迁移期兼容接口。旧格式先配对完整工具调用，再切窗；
  原生 ATIF 不反向转换成 Agent Work。

支持批次元数据中的 `run_dir`，且路径必须处于该任务目录内。旧日志支持完整
`runtime-trace.jsonl`、`runtime-artifacts/runtime-trace.jsonl`、v2 分块尾流和早期滚动尾流。
完整日志优先于尾流；滚动尾流保留已知的 trace coverage 起点。

后端已完成格式统一，前端仍需单独迁移消费链路并切换代理。前端保留实时增量合并
和 ATIF → UI 映射；迁移后可退役前端 Agent Work → ATIF 转换和 agent-work 兼容接口。

## HTTP 接口

`GET /api/health` 报告进程可响应、两个 Service 是否注入，不代表 OSS 已连通或
索引同步完成。`/api/docs` 和 `/api/openapi.json` 提供接口和参数定义。

| GET 路径 | 查询参数 |
|---|---|
| `/api/runs` | 可选 `date`：YYYY-MM-DD |
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
旧日志代表样本转换出的 21 步 ATIF 与现有 TypeScript 转换器输出一致；旧版转换
结果和原生完整文档均通过前端 ATIF 校验。没有上传对象或切换现有服务。

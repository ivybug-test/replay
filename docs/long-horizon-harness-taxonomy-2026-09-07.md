# Long-Horizon Agent Harness Problem Taxonomy

> Snapshot: 2026-09-07  
> Research window: 2026-03-07 — 2026-09-07  
> Taxonomy version: 2026-09-07.1  
> Skill schema: lhht-taxonomy/1.0.1

## Scope and method

本报告回答的是一个严格限定的问题：近六个月的论文、活跃项目和权威机构，明确提出或直接观察到了哪些**长程任务 agent harness 问题**。这里的 harness 指模型之外、负责上下文与状态、工具调用、执行编排、验证、恢复、权限和审计的运行层。长程机制至少涉及多轮累积、跨会话或跨环境传递、中断恢复、延迟后果、持久状态或委派链之一。

研究采用“先发现来源，再摘录 source finding，最后按机制聚类”的顺序。检索面覆盖 arXiv、论文官方网站、官方 GitHub 仓库及 API、Anthropic Engineering、NIST 和 United Nations University；检索语言为英语和中文，纳入证据均回到英文原始稿件或第一方页面。搜索结果和二手解读只用于发现，不作为节点证据。

核心节点的门槛为：至少三个独立来源组、至少两个 source family，且至少一个来源是 prominent 或 authoritative。`prominent` 只表示同时存在不同类别的可观察信号，例如社区关注加持续的一方维护；`authoritative` 表示标准机构、公共研究机构或平台方的第一方工程/政策材料。二者都不替代语义支持。两来源问题放入 `Corroborated candidates`，单来源问题放入 `Emerging and single-source candidates`。

归一化 ID 和中英文标签都是本报告的编辑性综合，不声称由任何单篇来源提出。证据表中的 `Source-stated problem` 才是来源自己的术语；引文保持简短，定位给出章节、段落、表或固定 commit。轨迹映射条件是在来源定义之后写出的操作化规则，不能反向创造 taxonomy。

## Source inventory

| Source | Family | Date/version | Authority | Corpus status | Independence group | Notability signals | Included findings |
|---|---|---|---|---|---|---|---|
| [LongHorizon-Harness](https://arxiv.org/html/2608.01964) | paper | 2026-08-03, arXiv v1 | primary preprint, Alibaba/DreamX | prominent | dreamx-longhorizon | [官方仓库](https://github.com/AMAP-ML/LongHorizon-Harness) 1,472 stars / 153 forks；2026-08-20 有代码更新，数值访问于 2026-09-07（community attention + first-party activity） | LHHT-STATE-001; LHHT-CTX-002; LHHT-PROG-003 |
| [OneDayAgent](https://arxiv.org/html/2608.05013) | paper | 2026-08-04, arXiv v1 | primary preprint | relevant primary | zjunlp-onedayagent | [官方仓库](https://github.com/zjunlp/OneDayAgent) 30 stars / 5 forks，2026-08-15 开源；尚不足以单列为热门锚点 | LHHT-STATE-001; LHHT-CTX-002 |
| [StructAgent](https://arxiv.org/html/2607.11388) | paper | 2026-07-13, arXiv v1 | primary preprint | relevant primary | structagent-team | [官方仓库](https://github.com/WenyiWU0111/StructAgent) 7 stars / 2 forks；新工作，未达 prominent 门槛 | LHHT-PROG-003; LHHT-VER-004 |
| [WeaveBench](https://arxiv.org/html/2606.09426) | paper | 2026-07-06, arXiv v3 | primary manuscript；官方仓库报告 EMNLP 2026 Main 接收 | prominent | weavebench-team | [官方仓库](https://github.com/weavebench/WeaveBench) 160 stars；2026-07 发布轨迹、2026-08-22 更新接收消息（community attention + first-party activity），访问于 2026-09-07 | LHHT-VER-004 |
| [HarnessFix](https://arxiv.org/html/2606.06324) | paper | 2026-07-02, arXiv v2 | primary preprint with a 30-repository study | relevant primary | harnessfix-team | 研究覆盖 30 个开源 agent、57,780 条开发记录；未找到满足 prominent 规则的独立传播信号 | LHHT-VER-004; LHHT-OBS-005; LHHT-REC-006; LHHT-GOV-008; candidate-regression |
| [Agentic Harness Engineering](https://arxiv.org/html/2604.25850) | paper | 2026-05-18, arXiv v4 | primary preprint | prominent | ahe-team | [官方仓库](https://github.com/china-qijizhifeng/agentic-harness-engineering) 870 stars / 98 forks，2026-08-03 有更新（community attention + first-party activity），访问于 2026-09-07 | LHHT-OBS-005; candidate-regression; candidate-staleness |
| [Model or Harness?](https://arxiv.org/html/2607.28802) | paper | 2026-07-30, arXiv v1 | primary preprint, Scale AI | relevant primary | scale-model-or-harness | 新 taxonomy，含人工标注和 judge 一致性实验；未把机构知名度当作传播度 | candidate-compaction; emerging-mistranslation; emerging-delegation |
| [AgentCanary](https://arxiv.org/html/2606.10484) | paper | 2026-06-09, arXiv v1 | primary security benchmark | relevant primary | agentcanary-team | [官方仓库](https://github.com/antgroup/Agent3Sigma-Canary) 37 stars；尚未满足 prominent 的强度要求 | LHHT-SEC-007 |
| [HarnessRisk](https://arxiv.org/html/2608.17597) | paper | 2026-08-18, arXiv v1 | primary security benchmark, under review | relevant primary | harnessrisk-team | 发布不足一个月，未用搜索排名代替传播度 | LHHT-SEC-007; LHHT-GOV-008; emerging-remediation |
| [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | authoritative-organization | 2026-03-24 | Anthropic first-party engineering report | authoritative | anthropic | 官方长程应用开发 harness 实验；authority route，不等同于独立学术复现 | LHHT-CTX-002; LHHT-PROG-003 |
| [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) | authoritative-organization | 2026-04-08 | Anthropic first-party production engineering report | authoritative | anthropic | 报告托管长程 agent 的实际基础设施失效与重构；与上一行同属一个 independence group | LHHT-STATE-001; LHHT-OBS-005; LHHT-REC-006; candidate-staleness |
| [Building Evaluation Probes into Agentic AI](https://www.nist.gov/programs-projects/building-evaluation-probes-agentic-ai) | authoritative-organization | 2026-05-01, updated 2026-05-05 | NIST ITL ongoing measurement project | authoritative | nist-itl | 美国国家计量机构第一方项目；authority route | LHHT-VER-004 |
| [Engineering and Governing the Agent Harness](https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer) | authoritative-organization | 2026-07-21 | United Nations University policy and engineering report | authoritative | unu | 联合国大学第一方报告；authority route | LHHT-REC-006; LHHT-SEC-007; candidate-compaction |
| [Symphony Service Specification](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md) | project | 2026-08-12 pinned commit | versioned official OpenAI project specification | prominent | openai-symphony | [官方仓库](https://github.com/openai/symphony) 27,067 stars / 2,780 forks；固定 commit 在窗口内、仓库 2026-08-19 仍有更新（community attention + first-party activity），访问于 2026-09-07 | LHHT-OBS-005; LHHT-GOV-008 |

说明：GitHub 数值是访问时快照，不是问题证据；同一论文及其官方仓库只算一个 independence group。Anthropic 两篇文章也只算一个来源组，所以没有被用来人为增加同一节点的独立来源数。

## Taxonomy overview

| ID | Normalized label | Harness locus | Evidence status | Independent origins |
|---|---|---|---|---:|
| LHHT-STATE-001 | Cross-boundary task-state discontinuity / 跨边界任务状态断裂 | state, handoff, session persistence | widely corroborated | 3 |
| LHHT-CTX-002 | Context-growth goal and constraint erosion / 上下文增长导致目标与约束侵蚀 | context selection, refresh, execution memory | widely corroborated | 3 |
| LHHT-PROG-003 | Producer-coupled progress acceptance / 执行者自证式进度采信 | progress ledger, completion gate, role separation | widely corroborated | 3 |
| LHHT-VER-004 | Partial-evidence verification blind spots / 局部证据验证盲区 | verifier, grader, observation surfaces | widely corroborated | 4 |
| LHHT-OBS-005 | Trajectory-to-cause observability break / 轨迹到根因的可观测性断裂 | logging, tracing, provenance, implementation linkage | widely corroborated | 4 |
| LHHT-REC-006 | Non-durable interruption recovery / 中断恢复缺乏持久状态 | retry, checkpoint, reconciliation, restart | widely corroborated | 3 |
| LHHT-SEC-007 | Persistent-state trust contamination / 持久状态信任污染 | memory, skills, policy/config state | widely corroborated | 3 |
| LHHT-GOV-008 | Consequential-action authorization erosion / 高影响动作授权边界失效 | credentials, permissions, approval gates | widely corroborated | 3 |

## Core taxonomy

<!-- taxonomy-entry:id=LHHT-STATE-001 -->
### LHHT-STATE-001 — Cross-boundary task-state discontinuity / 跨边界任务状态断裂

- **Editorial status:** normalized synthesis；不是来源共同使用的专有名词
- **Definition:** 已经产生且后续仍需要的任务状态，在跨环境、跨会话或运行容器失效的边界上没有被完整、可恢复地传递，导致后续步骤无法从真实进度继续。
- **Harness locus:** 外部 task-state store、会话日志、handoff artifact、环境间状态传递和恢复装载器。
- **Long-horizon mechanism:** 边界次数随任务时长增加；早期要求、已生成工件和环境事实必须在很久以后继续可用，一次遗漏会影响后续依赖链。
- **Evidence status:** widely corroborated
- **Independent origins:** 3 across 2 source families；prominent anchor 为 LongHorizon-Harness，authoritative anchor 为 Anthropic

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [LongHorizon-Harness](https://arxiv.org/html/2608.01964#S1.p2.1) | paper | Task-state loss | “Task-state loss” | §1, challenge (iii) | defines | dreamx-longhorizon |
| [OneDayAgent](https://arxiv.org/html/2608.05013#S1) | paper | state transfer failures | “intermediate state fails to transfer across environments” | §1, second long-horizon pressure paragraph | observes | zjunlp-onedayagent |
| [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents#dont-adopt-a-pet) | authoritative-organization | coupled-container session loss | “the session was lost” | “Don’t adopt a pet”, first paragraph | observes | anthropic |

#### Scope and boundaries

- **Supported scope:** 跨 GUI/CLI、web/file 环境、跨 session，以及 harness/container 故障后的可恢复状态连续性。
- **Not established:** 不能把“状态仍在但模型没有读取”算作本节点；那是检索/遵循问题。也不能把压缩时删除理由直接并入，本报告将它单列为候选。
- **Related nodes:** 与 LHHT-REC-006 相邻；本节点描述状态断裂，LHHT-REC-006 描述恢复控制如何因此重放或无法继续。

#### Trajectory-mapping criteria

- **Required evidence:** 边界前存在可验证状态，边界后该状态在输入、handoff、session log 或 task ledger 中缺失或错误。
- **Positive pattern:** 产生要求/工件/事实 → 切换环境、会话或 worker → 后续 agent 重新发现、遗漏或重复已完成工作 → 缺失状态能解释后续偏差。
- **Counterevidence/exclusions:** 状态在边界后完整可见但 agent 忽略；首次就未发现信息；仅有最终失败而无跨边界证据。
- **Likely evidence surfaces:** session/event log、handoff 文件、task ledger、跨环境工具输入、workspace diff、恢复时加载记录。

<!-- /taxonomy-entry -->

<!-- taxonomy-entry:id=LHHT-CTX-002 -->
### LHHT-CTX-002 — Context-growth goal and constraint erosion / 上下文增长导致目标与约束侵蚀

- **Editorial status:** normalized synthesis；汇总来源中的 context rot、goal drift 和 lose coherence
- **Definition:** 随执行历史增长，原始目标或约束在模型可用上下文中的可检索性和控制力下降，使后续决策偏离原始任务合同。
- **Harness locus:** 上下文选择、预算分配、约束刷新、execution memory 和原始任务合同的持续注入。
- **Long-horizon mechanism:** 新观察、工具输出和局部目标不断占据上下文；越早的全局要求越容易被近期内容遮蔽，偏差又会在后续步骤中累积。
- **Evidence status:** widely corroborated
- **Independent origins:** 3 across 2 source families；prominent anchor 为 LongHorizon-Harness，authoritative anchor 为 Anthropic

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [LongHorizon-Harness](https://arxiv.org/html/2608.01964#S1.p2.1) | paper | Context rot | “Context rot” | §1, challenge (ii) | defines | dreamx-longhorizon |
| [OneDayAgent](https://arxiv.org/html/2608.05013#S1) | paper | goals drift under context accumulation | “Goals drift from accumulated constraints” | §1, paragraph beginning “As the horizon grows” | observes | zjunlp-onedayagent |
| [Anthropic long-running harness report](https://www.anthropic.com/engineering/harness-design-long-running-apps#why-naive-implementations-fall-short) | authoritative-organization | loss of coherence on lengthy tasks | “lose coherence on lengthy tasks as the context window fills” | “Why naive implementations fall short”, first failure mode | observes | anthropic |

#### Scope and boundaries

- **Supported scope:** 长任务中由不断增长的交互历史和上下文压力引起的目标、约束与整体一致性丢失。
- **Not established:** 不把纯模型推理错误、知识缺失或一次性指令不遵循算作本节点；也不把有明确压缩事件的 rationale loss 混入核心节点。
- **Related nodes:** 跨环境的状态缺失属于 LHHT-STATE-001；有可定位压缩事件并删除理由的情况属于 `candidate-compaction`。

#### Trajectory-mapping criteria

- **Required evidence:** 原始合同中存在清晰要求；后续上下文显著增长；偏离发生时该要求未被刷新、不可见或被近期局部目标覆盖。
- **Positive pattern:** 早期约束 → 多轮工具和局部任务累积 → 后续计划/动作与约束冲突 → 未见外部状态变化足以解释该冲突。
- **Counterevidence/exclusions:** 约束在当前输入中清晰可见且 agent 仍忽略；用户后来明确修改目标；压缩日志明确显示删除理由时优先映射候选 compaction 节点。
- **Likely evidence surfaces:** 原始用户指令、每轮实际 model input、token/compaction 事件、任务合同快照、计划版本、最终工件差异。

<!-- /taxonomy-entry -->

<!-- taxonomy-entry:id=LHHT-PROG-003 -->
### LHHT-PROG-003 — Producer-coupled progress acceptance / 执行者自证式进度采信

- **Editorial status:** normalized synthesis；替代原先没有来源依据的“进度声明漂移”标签
- **Definition:** 执行工作的一方同时判断并提交自己的完成状态，而 harness 在缺少独立环境证据时让该声明推进持久进度或最终完成状态。
- **Harness locus:** progress ledger 写入权限、DONE gate、producer/evaluator 角色隔离和环境只读审计。
- **Long-horizon mechanism:** 一次错误完成判断会进入持久任务状态，成为后续规划前提；随着依赖链增长，错误进度会传播而非局部消失。
- **Evidence status:** widely corroborated
- **Independent origins:** 3 across 2 source families；prominent anchor 为 LongHorizon-Harness，authoritative anchor 为 Anthropic

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [LongHorizon-Harness](https://arxiv.org/html/2608.01964#S1.p3) | paper | coupled execution and completion assessment | “Task execution and completion assessment remain coupled” | §1, structural limitation (ii) | states-limitation | dreamx-longhorizon |
| [StructAgent](https://arxiv.org/html/2607.11388#S5.SS0.SSS0.Px1) | paper | false progress commits | “completion claims are proposals, not progress updates” | §5, Q1 | observes | structagent-team |
| [Anthropic long-running harness report](https://www.anthropic.com/engineering/harness-design-long-running-apps#why-naive-implementations-fall-short) | authoritative-organization | positively biased self-evaluation | “agents reliably skew positive when grading their own work” | “Why naive implementations fall short”, second failure mode | observes | anthropic |

#### Scope and boundaries

- **Supported scope:** 执行者自产声明与 harness 进度提交权耦合，包括中间 subgoal 和最终 DONE。
- **Not established:** 来源没有提出“进度声明漂移”这一术语；本节点也不等同于任何进度值随时间自然变化。若独立 verifier 存在但看不到关键证据，应映射 LHHT-VER-004。
- **Related nodes:** LHHT-VER-004 关注 verifier 的证据覆盖；本节点关注谁有权把声明变成状态。

#### Trajectory-mapping criteria

- **Required evidence:** producer 明确声称完成；持久状态随后推进；推进前没有独立读取环境、工件或 verifier 输出。
- **Positive pattern:** actor 执行 → actor 报告完成 → harness 直接标记 complete/DONE → 后续步骤以该标记为事实 → 环境证据显示未完成或错误对象。
- **Counterevidence/exclusions:** 完成由独立 verifier 基于环境证据确认；只出现夸大的自然语言但没有改变控制状态；最终失败来自 grader 证据不全。
- **Likely evidence surfaces:** actor 输出、状态更新事件、任务数据库、DONE 决策、auditor 调用记录、环境 diff 与后续计划输入。

<!-- /taxonomy-entry -->

<!-- taxonomy-entry:id=LHHT-VER-004 -->
### LHHT-VER-004 — Partial-evidence verification blind spots / 局部证据验证盲区

- **Editorial status:** normalized synthesis；汇总 final-only、screenshot-only、validator blind spots 和 evidence visibility gap
- **Definition:** verifier 或 grader 只观察最终文本、单一界面、代理指标或不完整工件，因而无法判断真实环境效果、隐藏状态或过程约束是否满足。
- **Harness locus:** 验证器输入面、环境探针、artifact/state diff、trajectory-aware grading 和 evidence provenance。
- **Long-horizon mechanism:** 长程任务的成功条件分散在多种状态和多个时间点；最终表象可能与早先动作、持久文件或真实副作用不一致。
- **Evidence status:** widely corroborated
- **Independent origins:** 4 across 2 source families；prominent anchor 为 WeaveBench，authoritative anchor 为 NIST

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [WeaveBench](https://arxiv.org/html/2606.09426#S3.SS4.p1.1) | paper | final-only grading vulnerability | “Final-only grading is therefore vulnerable to shortcuts” | §3, “Trajectory-aware Agent as Judge” | observes | weavebench-team |
| [StructAgent](https://arxiv.org/html/2607.11388#S5.SS0.SSS0.Px1) | paper | visually plausible but semantically incomplete state | “a visually plausible screen may still hide a missing file” | §5, Q1 | observes | structagent-team |
| [HarnessFix](https://arxiv.org/html/2606.06324#S2.T2) | paper | Verification and Evaluation flaws | “do not catch invalid artifacts, missing effects” | Table II, Verification and Evaluation row | defines | harnessfix-team |
| [NIST evaluation probes project](https://www.nist.gov/programs-projects/building-evaluation-probes-agentic-ai) | authoritative-organization | insufficient workflow evidence visibility | “need increased visibility into the chain of reasoning, tool usage, and gathered evidence” | Overview, first paragraph | states-limitation | nist-itl |

#### Scope and boundaries

- **Supported scope:** 运行时 verifier 与评测 grader 的证据输入不足；包括 final-only、visual-only、单一 proxy 和缺失 provenance。
- **Not established:** 不能仅因 grader 判错就归因；必须指出本应可检查但未被提供/检查的证据面。也不等同于 producer 自评偏置。
- **Related nodes:** LHHT-PROG-003 是控制权问题；LHHT-OBS-005 是事后诊断和根因定位问题。

#### Trajectory-mapping criteria

- **Required evidence:** 任务合同需要至少一种 verifier 未检查的可观察状态；被采信的证据与真实结果可同时展示。
- **Positive pattern:** 代理/局部证据通过 → harness 接受进度或得分 → 文件、数据库、应用状态、动作记录或 provenance 中出现反证。
- **Counterevidence/exclusions:** verifier 检查了必要证据但判断推理错误；producer 声明未经任何 verifier 直接被接受；任务本身没有可检查的外部状态。
- **Likely evidence surfaces:** grader prompt/input、截图、文件树和内容、数据库/服务状态、工具调用序列、reference anchors、verdict rationale。

<!-- /taxonomy-entry -->

<!-- taxonomy-entry:id=LHHT-OBS-005 -->
### LHHT-OBS-005 — Trajectory-to-cause observability break / 轨迹到根因的可观测性断裂

- **Editorial status:** normalized synthesis；把来源中的 fragmented evidence、buried signal 和 indistinguishable failure presentations 归到同一诊断机制
- **Definition:** harness 记录的轨迹缺字段、缺关联或体量不可消费，使观察到的失败无法可靠追溯到具体请求、工具结果、状态变化和实现组件。
- **Harness locus:** structured logging、trace schema、data/control-flow link、state delta、request snapshot、实现锚点和并发 run identity。
- **Long-horizon mechanism:** 事件数量、并发 worker、跨组件交互和状态变换随时长增长；根因与最终症状之间的距离越来越大。
- **Evidence status:** widely corroborated
- **Independent origins:** 4 across 3 source families；prominent anchors 为 AHE 和 Symphony，authoritative anchor 为 Anthropic

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [HarnessFix](https://arxiv.org/html/2606.06324#S1.p4) | paper | fragmented failure evidence | “failure evidence is fragmented” | §I, challenge 1 | states-limitation | harnessfix-team |
| [Agentic Harness Engineering](https://arxiv.org/html/2604.25850#Sx1) | paper | actionable signal buried in trajectories | “voluminous trajectories that bury actionable signal” | Abstract and §1 | states-limitation | ahe-team |
| [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents#dont-adopt-a-pet) | authoritative-organization | indistinguishable infrastructure failures | “couldn’t tell us where failures arose” | “Don’t adopt a pet”, second paragraph | observes | anthropic |
| [Symphony Service Specification](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L203-L212) | project | multi-run operational observability | “debug multiple concurrent agent runs” | §1 Problem Statement, lines 203–212 | documents | openai-symphony |

#### Scope and boundaries

- **Supported scope:** 轨迹和运行日志不足以做 step-level、component-level 或并发 run 的故障归因。
- **Not established:** 日志齐全但分析器推理错误不属于本节点；单纯 token 成本高也不构成可观测性断裂。
- **Related nodes:** LHHT-VER-004 面向“是否完成”的证据；本节点面向“为何失败、该改哪里”的证据链。

#### Trajectory-mapping criteria

- **Required evidence:** 可见最终症状，但关键 request、tool result、error、state delta、run ID 或实现版本之一缺失/未关联，导致至少两个根因解释不可区分。
- **Positive pattern:** 远端症状出现 → 追溯时发现关键字段或边缺失 → 不同故障源在日志中呈现相同 → 无法把修复定位到 harness artifact。
- **Counterevidence/exclusions:** 完整事件链允许唯一或高置信定位；只是日志很多但有可用索引和 provenance；只有 evaluator 证据覆盖不足。
- **Likely evidence surfaces:** JSONL/event log、trace IDs、model request snapshots、tool call/result、error stack、state diff、commit/config hash、并发调度记录。

<!-- /taxonomy-entry -->

<!-- taxonomy-entry:id=LHHT-REC-006 -->
### LHHT-REC-006 — Non-durable interruption recovery / 中断恢复缺乏持久状态

- **Editorial status:** normalized synthesis；聚合 retry loop、session loss 和 restart recovery 问题
- **Definition:** 中断、超时或 worker 故障后，harness 没有以持久状态和权威 reconciliation 点恢复，因而丢失会话、从错误位置继续或重复无效动作。
- **Harness locus:** durable event log、checkpoint、retry classification、idempotency、claimed/running state 和 tracker/filesystem reconciliation。
- **Long-horizon mechanism:** 长任务更可能跨越瞬态故障和进程重启；从头重跑成本高，盲重试还会重复有副作用的动作。
- **Evidence status:** widely corroborated
- **Independent origins:** 3 across 2 source families；authoritative anchors 为 Anthropic 与 United Nations University

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [HarnessFix](https://arxiv.org/html/2606.06324#S2.T2) | paper | Lifecycle and Orchestration retry failure | “enters retry loops, repeats ineffective actions” | Table II, Lifecycle and Orchestration row | defines | harnessfix-team |
| [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents#dont-adopt-a-pet) | authoritative-organization | non-restartable coupled infrastructure | “we had to nurse it back to health” | “Don’t adopt a pet”, first paragraph | observes | anthropic |
| [UNU harness report](https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer) | authoritative-organization | interruption and recovery failures | “repeated actions after interruption” | body paragraph beginning “These patterns have emerged” | states-limitation | unu |

#### Scope and boundaries

- **Supported scope:** harness/process/container 中断后的状态恢复、重试和 reconciliation；不是模型在一次正常会话里主动换策略的能力。
- **Not established:** 单次工具报错、由用户明确要求的完全重跑，以及有幂等保护的正常 retry 不构成本节点。
- **Related nodes:** 若恢复失败是因为 handoff 中状态根本未传递，同时标注 LHHT-STATE-001；若只是 verifier 阻止重试推进，则看 LHHT-PROG-003。

#### Trajectory-mapping criteria

- **Required evidence:** 明确中断/超时/崩溃事件、恢复尝试，以及恢复点和权威状态来源。
- **Positive pattern:** 运行中断 → 无持久 checkpoint 或 reconciliation → 新 worker 从旧/空状态启动 → 重放已完成动作、丢失会话或进入无效 retry loop。
- **Counterevidence/exclusions:** 从最后一个持久事件准确恢复；重复动作由幂等键去重且无副作用；仅仅执行速度慢。
- **Likely evidence surfaces:** process lifecycle、retry queue、checkpoint/event log、tracker status、claimed/running maps、idempotency keys、workspace 快照。

<!-- /taxonomy-entry -->

<!-- taxonomy-entry:id=LHHT-SEC-007 -->
### LHHT-SEC-007 — Persistent-state trust contamination / 持久状态信任污染

- **Editorial status:** normalized synthesis；这是安全威胁节点，不是一般能力或进度节点
- **Definition:** 来自不可信内容的指令、规则或配置被写入被后续会话默认信任的持久状态，并在延迟触发时造成未授权或有害行为。
- **Harness locus:** long-term memory、skills/extensions、project context、policy/config store、provenance 与写入授权。
- **Long-horizon mechanism:** 植入与触发跨越多个回合或会话；污染内容在时间上与当前看似良性的请求解耦，影响可持续存在。
- **Evidence status:** widely corroborated
- **Independent origins:** 3 across 2 source families；authoritative anchor 为 United Nations University

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [AgentCanary](https://arxiv.org/html/2606.10484#S4.SS3) | paper | Memory contamination | “persistent state can contain unsafe rules” | §4.3, Memory Contamination Tasks | measures | agentcanary-team |
| [HarnessRisk](https://arxiv.org/html/2608.17597#S2.SS2.p5.1) | paper | State Persistence failure | “transient adversarial content is written into trusted state and later reused” | §2.2, State Persistence | defines | harnessrisk-team |
| [UNU harness report](https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer) | authoritative-organization | memory poisoning and procedural drift | “Memory poisoning and procedural drift” | body paragraph beginning “The report also identifies” | states-limitation | unu |

#### Scope and boundaries

- **Supported scope:** 有威胁模型的持久内存、skill、extension、配置或策略污染；后果通过后续正常工作流实现。
- **Not established:** 不把普通 stale memory、摘要遗漏或能力下降算作安全污染；HarnessRisk 的 lifecycle taxonomy 只支撑本安全节点及权限节点。
- **Related nodes:** 无攻击/不可信来源证据的状态丢失属于 LHHT-STATE-001；压缩删除约束属于 candidate-compaction。

#### Trajectory-mapping criteria

- **Required evidence:** 不可信输入或工件、持久写入事件、后续读取/触发，以及与用户当前授权不一致的动作或策略变化。
- **Positive pattern:** 攻击内容进入 → 写入 memory/skill/config → 跨回合或重启保留 → 良性请求触发 → 发生未授权副作用。
- **Counterevidence/exclusions:** 内容只存在于当前上下文；持久项有可信来源和明确用户授权；普通陈旧事实造成的错误。
- **Likely evidence surfaces:** memory diff、skill/plugin 安装与修改记录、provenance 标签、配置 commit、跨 session tool calls、安全检测与副作用日志。

<!-- /taxonomy-entry -->

<!-- taxonomy-entry:id=LHHT-GOV-008 -->
### LHHT-GOV-008 — Consequential-action authorization erosion / 高影响动作授权边界失效

- **Editorial status:** normalized synthesis；安全/治理节点
- **Definition:** harness 暴露的凭据、权限或审批流不能持续约束高影响动作，使 agent 或其子进程能够越过原定主机、身份或人工确认边界。
- **Harness locus:** credential injection、least privilege、approval gate、identity boundary、child-process environment 和 policy enforcement。
- **Long-horizon mechanism:** 权限上下文会跨多步、跨子进程和跨委派传播；早先授权容易被误当作对后续不同目标或更大范围动作的持续授权。
- **Evidence status:** widely corroborated
- **Independent origins:** 3 across 2 source families；prominent project anchor 为 OpenAI Symphony

#### Original-source evidence

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [HarnessFix](https://arxiv.org/html/2606.06324#S2.T2) | paper | Governance and Security approval weakness | “approval flows ... are too weak” | Table II, Governance and Security row | defines | harnessfix-team |
| [HarnessRisk](https://arxiv.org/html/2608.17597#S2.SS2.p6.1) | paper | Action Control risk | “authorizes irreversible or sensitive actions without sufficient validation” | §2.2, Action Control | defines | harnessrisk-team |
| [OpenAI Symphony credential-isolation fix](https://github.com/openai/symphony/commit/8001b52e3062495a16e520e4ceaf8f9de868c4d0) | project | child process credential-boundary bypass | “bypass Symphony's host-side boundary” | commit 8001b52, Context | documents | openai-symphony |

#### Scope and boundaries

- **Supported scope:** 凭据继承、权限过宽、审批缺失或授权目标替换造成的 harness 安全边界失效。
- **Not established:** 不把 agent 在既有合法权限内做错普通操作自动标成权限问题；也不把安全节点推广成能力 taxonomy。
- **Related nodes:** 持久配置被攻击者污染属于 LHHT-SEC-007；有权限但 verifier 看不到副作用属于 LHHT-VER-004。

#### Trajectory-mapping criteria

- **Required evidence:** 原定权限/审批合同、实际 credential/permission 暴露、具体高影响动作，以及缺失或被绕过的 gate。
- **Positive pattern:** host/owner 设定边界 → 凭据继承或 scope 扩大 → agent/child process 未经必要确认执行高影响动作 → 外部副作用成立。
- **Counterevidence/exclusions:** 用户对同一目标和范围给出明确、当前授权；动作在 sandbox 内且无外部影响；仅有模型提出动作但 harness 阻止执行。
- **Likely evidence surfaces:** environment variables、credential broker logs、approval events、policy verdicts、tool scopes、child-process launch config、外部 API transaction records。

<!-- /taxonomy-entry -->

## Corroborated candidates

以下问题已有两个独立来源，但没有达到核心节点的三来源门槛。

### candidate-compaction — Context-compaction rationale and audit loss / 上下文压缩导致理由与审计信息丢失

归一化机制：harness 的压缩/摘要保留表层动作，却删除支撑该动作的理由、约束或可审计变换记录。它没有并入 LHHT-CTX-002，因为这里要求能定位到具体 compaction/summarization 事件。

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [Model or Harness?](https://arxiv.org/html/2607.28802#A2.SS0.SSS0.Px4) | paper | Context Rationale Erosion | “dropping the reasoning or constraint that justified it” | Appendix B, context—model | defines | scale-model-or-harness |
| [UNU harness report](https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer) | authoritative-organization | context-compaction audit opacity | “Context compaction can create audit opacity” | body paragraph beginning “The report also identifies” | states-limitation | unu |

### candidate-regression — Harness-change regression blindness / Harness 变更回归盲区

归一化机制：自动或人工修复一个 harness failure 时，由于组件耦合和行为非确定性，没有预见或检测其他任务上的回归。当前两项证据均来自论文，仍需独立项目/组织运行报告。

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [Agentic Harness Engineering](https://arxiv.org/html/2604.25850#S4.SS4.SSS2) | paper | Regression blindness | “blind to regressions” | §4.4.2, Regression blindness | measures | ahe-team |
| [HarnessFix](https://arxiv.org/html/2606.06324#S1.p4) | paper | regression after harness modification | “introducing regressions elsewhere” | §I, challenge 3 | states-limitation | harnessfix-team |

### candidate-staleness — Harness-assumption staleness across model changes / 模型变化导致 Harness 假设过时

归一化机制：为旧模型缺陷加入的编排组件在模型升级后失去作用或变成负担，而为一个模型调优的 harness 未必可迁移到另一个模型。

| Source | Source family | Source-stated problem | Brief original wording | Locator | Relation | Independence group |
|---|---|---|---|---|---|---|
| [Agentic Harness Engineering](https://arxiv.org/html/2604.25850#S1) | paper | model-specific optimal harness | “the optimal harness is model-specific” | §1, paragraph 3 | states-limitation | ahe-team |
| [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) | authoritative-organization | stale reset assumption | “The resets had become dead weight” | opening example, paragraph 2 | observes | anthropic |

## Emerging and single-source candidates

| Candidate | Source and family | Source-stated problem | Brief original wording | Locator | Relation | Why not core |
|---|---|---|---|---|---|---|
| Tool-boundary semantic mistranslation / 工具边界语义错译 | [Model or Harness?](https://arxiv.org/html/2607.28802#A2.SS0.SSS0.Px6), paper | Mistranslation (tool) | “conveys it unfaithfully” | Appendix B, model—tool | defines | 只有一个直接来源；不能与模型生成 malformed arguments 混为一类 |
| Multi-agent handoff information loss / 多 Agent 交接信息丢失 | [Model or Harness?](https://arxiv.org/html/2607.28802#A2.SS0.SSS0.Px8), paper | Communication Failure (focal model/subagent) | “omits context needed by a subagent” | Appendix B, focal model/subagent | defines | 窗口内只有一个直接定义；HarnessFix 的“delegates without verification”是不同机制 |
| Detection without remediation / 检测后未完成处置 | [HarnessRisk](https://arxiv.org/html/2608.17597#A6.SS0.SSS0.Px4), paper | detection-remediation separation | “Detection does not guarantee remediation” | Appendix F, qualitative mechanism 4 | observes | 单一安全 benchmark；等待独立运行数据 |

## Disagreements and unresolved boundaries

1. **“Goal drift”并不天然是 harness 问题。** OneDayAgent 和 LongHorizon-Harness把它放在长程上下文/状态管理压力下；`Model or Harness?` 则把其 `Goal Drift` 定义在 model fault side。因而 LHHT-CTX-002 只在轨迹能显示上下文增长、约束刷新或选择机制时使用；若约束仍完整可见，应保留 model-side 解释。
2. **producer 自评与 verifier 证据不全是两个问题。** LHHT-PROG-003 要求 harness 让 producer 的声明直接改变进度；LHHT-VER-004 要求已经存在 verifier，但它只看局部或代理证据。两者可以共现，但不能只凭“错误 DONE”任选其一。
3. **状态传递丢失与状态读取失败不同。** LHHT-STATE-001 要求边界后数据确实缺失/损坏；数据完整存在但 agent 没读属于 retrieval/model-following，当前没有足够的两 source-family 证据形成核心 harness 节点。
4. **能力与安全必须分层。** HarnessRisk 和 AgentCanary 的目标是攻击条件下的安全、持久 compromise 和授权控制；本报告只用它们支撑 LHHT-SEC-007 与 LHHT-GOV-008，绝不用于支撑进度、能力或一般可靠性节点。
5. **设计规范与经验观察的证据强度不同。** Symphony 的规范和修复 commit 证明项目把可观测性、恢复和凭据隔离当作实际工程合同/缺陷面；它们不等于跨系统频率测量，所以每个相关核心节点同时保留独立论文或生产报告。

## Discovery candidate log and exclusions

| Candidate source/type | Decision | Reason |
|---|---|---|
| Anthropic, “Demystifying evals for AI agents” (2026-01-09) | excluded from evidence count | 早于 2026-03-07；只可作为基础背景，未用于节点计数 |
| Anthropic, “How we built our multi-agent research system” (2025) | excluded from evidence count | 超出六个月窗口；因此没有拿它给 multi-agent candidate 补第三来源 |
| `Long-Horizon Agent Trajectory Attribution` (arXiv:2608.06909) | rejected as node-defining source | 直接问题主要是 attribution benchmark/dataset 覆盖，不是已观察到的 harness 运行失效机制 |
| Relay、agent-harness-lab 等小型新项目 README | rejected from core evidence | 多数只陈述功能或设计建议，缺少明确问题段落；传播与独立采用信号也不足 |
| alphaXiv、博客和搜索摘要 | discovery only | 二手来源，不作为原文引用或独立 origin |
| `Model or Harness?` 中的 reasoning、knowledge、satisficing、tool-selection 等 model-side modes | out of scope | 来源明确把责任放在 model side，不能为填满 harness taxonomy 而改写归属 |
| HarnessRisk 的六个 lifecycle phase | not treated as six failure nodes | phase 是安全责任范围，不是能力 taxonomy，也不是每个 phase 各自等于一个具体问题 |

## Coverage gaps and research limitations

- **时间与成熟度偏差：** 2026 年 7–8 月工作很新，引用数尚不稳定，所以 prominence 主要依赖官方仓库关注和持续活动；没有把搜索排名或机构名气当作传播证明。
- **来源分布偏差：** 核心证据明显偏向 coding/computer-use agent；研究、办公和业务流程 agent 的公开、可复现实例更少。
- **组织报告的独立性：** 同一组织的多篇文章只算一个 origin。权威页面能证明一方实践，不能替代独立复现。
- **项目文档的表达偏差：** 项目往往以 requirements/mitigations 描述问题，而不是报告发生频率；只有明确 problem statement 或修复 commit 被计入。
- **论文状态：** 多数为 preprint；WeaveBench 的会议接收信息来自其官方仓库，本报告未把该声明升级为独立来源。
- **引文定位：** arXiv HTML anchor 绑定当前列出的版本；如果 arXiv 后续换版，应先重新核对原文再刷新 taxonomy。
- **轨迹映射尚未执行：** 本文只给出 mapping criteria。具体 AFT 轨迹必须另做证据链标注，不能因某段轨迹“看起来像”就扩展节点定义。
- **非穷尽性：** 达不到三来源门槛的问题被降级，而不是用推断补齐；因此 taxonomy 有意比常见的宽泛问题清单更小。

## Bibliography

1. Ma et al. [LongHorizon-Harness: Advancing Long-Horizon Agents for Real-World Tasks](https://arxiv.org/html/2608.01964), arXiv:2608.01964v1, 2026-08-03.
2. Zheng et al. [OneDayAgent: Towards a Long-Horizon Harness for Autonomous Agents](https://arxiv.org/html/2608.05013), arXiv:2608.05013v1, 2026-08-04.
3. Wu et al. [StructAgent: Harness Long-horizon Digital Agents with Unified Causal Structure](https://arxiv.org/html/2607.11388), arXiv:2607.11388v1, 2026-07-13.
4. Li et al. [WeaveBench: A Long-Horizon, Real-World Benchmark for Computer-Use Agents with Hybrid Interfaces](https://arxiv.org/html/2606.09426), arXiv:2606.09426v3, 2026-07-06.
5. Chen et al. [From Failed Trajectories to Reliable LLM Agents: Diagnosing and Repairing Harness Flaws](https://arxiv.org/html/2606.06324), arXiv:2606.06324v2, 2026-07-02.
6. Lin et al. [Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses](https://arxiv.org/html/2604.25850), arXiv:2604.25850v4, 2026-05-18.
7. Raj et al. [Model or Harness? An Interaction-Centric Taxonomy for Localizing Agent Failures](https://arxiv.org/html/2607.28802), arXiv:2607.28802v1, 2026-07-30.
8. Li et al. [AgentCanary: A Security Evaluation Framework for Autonomous AI Agents in Real Executable Environments](https://arxiv.org/html/2606.10484), arXiv:2606.10484v1, 2026-06-09.
9. [HarnessRisk: A Lifecycle-Oriented Benchmark for Agent Harness Safety](https://arxiv.org/html/2608.17597), arXiv:2608.17597v1, 2026-08-18.
10. Anthropic. [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), 2026-03-24.
11. Anthropic. [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents), 2026-04-08.
12. NIST ITL. [Building Evaluation Probes into Agentic AI](https://www.nist.gov/programs-projects/building-evaluation-probes-agentic-ai), 2026-05-01, updated 2026-05-05.
13. United Nations University. [Engineering and Governing the Agent Harness: A Technology and Policy Framework for the Runtime Layer of Agentic AI](https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer), 2026-07-21.
14. OpenAI. [Symphony Service Specification](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md), pinned commit `8001b52`, 2026-08-12; [credential-isolation fix](https://github.com/openai/symphony/commit/8001b52e3062495a16e520e4ceaf8f9de868c4d0).

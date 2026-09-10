"""Source-grounded taxonomy for long-horizon agent-harness problems.

Labels and definitions are editorial normalizations over the linked original
findings. They are mapping targets, never evidence that a run exhibited a
problem. Every node carries its own sources with locators and exclusion
conditions; this module is the reference for them.
"""

TAXONOMY_VERSION = 'lhht/2026-09-07.1'
RESEARCH_MAP_VERSION = 'lhht-research/2026-09-07.1'
RESEARCH_WINDOW = ('2026-03-07', '2026-09-07')

# source_id, title, url, published_at, organization, authority_tier, weight
SOURCES = [
    ('longhorizon-harness', 'LongHorizon-Harness',
     'https://arxiv.org/html/2608.01964', '2026-08-03',
     'Alibaba / DreamX', 'T2_primary_preprint_prominent', .82),
    ('onedayagent', 'OneDayAgent', 'https://arxiv.org/html/2608.05013',
     '2026-08-04', 'Zhejiang University', 'T2_primary_preprint', .70),
    ('structagent', 'StructAgent', 'https://arxiv.org/html/2607.11388',
     '2026-07-13', 'research authors', 'T2_primary_preprint', .68),
    ('weavebench', 'WeaveBench', 'https://arxiv.org/html/2606.09426',
     '2026-07-06', 'WeaveBench team', 'T2_primary_manuscript_prominent', .82),
    ('harnessfix', 'HarnessFix', 'https://arxiv.org/html/2606.06324',
     '2026-07-02', 'research authors', 'T2_primary_preprint', .76),
    ('harness-engineering', 'Agentic Harness Engineering',
     'https://arxiv.org/html/2604.25850', '2026-05-18',
     'research authors', 'T2_primary_preprint_prominent', .80),
    ('agentcanary', 'AgentCanary', 'https://arxiv.org/html/2606.10484',
     '2026-06-09', 'Ant Group', 'T2_primary_security_benchmark', .74),
    ('harnessrisk', 'HarnessRisk', 'https://arxiv.org/html/2608.17597',
     '2026-08-18', 'research authors', 'T2_primary_security_benchmark', .72),
    ('anthropic-long-running', 'Harness design for long-running application development',
     'https://www.anthropic.com/engineering/harness-design-long-running-apps',
     '2026-03-24', 'Anthropic', 'T3_first_party_engineering', .82),
    ('anthropic-managed', 'Scaling Managed Agents',
     'https://www.anthropic.com/engineering/managed-agents', '2026-04-08',
     'Anthropic', 'T3_first_party_engineering', .82),
    ('nist-probes', 'Building Evaluation Probes into Agentic AI',
     'https://www.nist.gov/programs-projects/building-evaluation-probes-agentic-ai',
     '2026-05-01', 'NIST ITL', 'T3_authoritative_organization', .86),
    ('unu-harness', 'Engineering and Governing the Agent Harness',
     'https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer',
     '2026-07-21', 'United Nations University',
     'T3_authoritative_organization', .84),
    ('openai-symphony', 'Symphony Service Specification',
     'https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md',
     '2026-08-12', 'OpenAI', 'T0_versioned_official_project', .92),
]


def _tag(tag_id, name_zh, name_en, description, signals, exclusions):
    return (tag_id, name_zh, name_en, description, signals, exclusions,
            'not pre-assigned', 'editorial-synthesis-from-original-findings', [])


TAGS = [
    _tag('LHHT-STATE-001', '跨边界任务状态断裂',
         'Cross-boundary task-state discontinuity',
         '已经产生且后续仍需要的任务状态，在跨环境、跨会话或运行容器失效的边界上没有被完整、可恢复地传递，导致后续步骤无法从真实进度继续。',
         ['边界前存在可验证状态，边界后该状态在输入、handoff、session log 或 task ledger 中缺失或错误。'],
         ['状态完整可见但 Agent 忽略。', '首次就未发现信息。', '只有最终失败而无跨边界证据。']),
    _tag('LHHT-CTX-002', '上下文增长导致目标与约束侵蚀',
         'Context-growth goal and constraint erosion',
         '随执行历史增长，原始目标或约束在模型可用上下文中的可检索性和控制力下降，使后续决策偏离原始任务合同。',
         ['原始合同有清晰要求、后续上下文明显增长，且偏离时要求未刷新、不可见或被近期局部目标覆盖。'],
         ['约束在当前输入中清晰可见但 Agent 仍忽略。', '用户后来明确改变目标。']),
    _tag('LHHT-PROG-003', '执行者自证式进度采信',
         'Producer-coupled progress acceptance',
         '执行工作的一方同时判断并提交自己的完成状态，而 harness 在缺少独立环境证据时让该声明推进持久进度或最终完成状态。',
         ['Producer 明确声称完成，持久状态随后推进，推进前没有独立环境读取或 verifier 结论。'],
         ['独立 verifier 基于环境证据确认完成。', '自然语言夸大但没有改变控制状态。']),
    _tag('LHHT-VER-004', '局部证据验证盲区',
         'Partial-evidence verification blind spots',
         'Verifier 或 grader 只观察最终文本、单一界面、代理指标或不完整工件，因而无法判断真实环境效果、隐藏状态或过程约束是否满足。',
         ['任务合同需要 verifier 未检查的可观察状态，且被采信证据与真实结果的反证能够同时展示。'],
         ['Verifier 已检查必要证据但判断推理错误。', 'Producer 声明未经 verifier 直接被接受。']),
    _tag('LHHT-OBS-005', '轨迹到根因的可观测性断裂',
         'Trajectory-to-cause observability break',
         'Harness 记录的轨迹缺字段、缺关联或体量不可消费，使观察到的失败无法可靠追溯到具体请求、工具结果、状态变化和实现组件。',
         ['存在最终症状，但关键 request、tool result、error、state delta、run ID 或实现版本缺失或未关联。'],
         ['完整事件链允许高置信定位。', '日志很多但存在可用索引和 provenance。']),
    _tag('LHHT-REC-006', '中断恢复缺乏持久状态',
         'Non-durable interruption recovery',
         '中断、超时或 worker 故障后，harness 没有以持久状态和权威 reconciliation 点恢复，因而丢失会话、从错误位置继续或重复无效动作。',
         ['存在明确中断、超时或崩溃事件、恢复尝试，以及可检查的恢复点和权威状态来源。'],
         ['从最后持久事件准确恢复。', '重复动作由幂等键去重且没有副作用。', '仅执行速度慢。']),
    _tag('LHHT-SEC-007', '持久状态信任污染',
         'Persistent-state trust contamination',
         '来自不可信内容的指令、规则或配置被写入被后续会话默认信任的持久状态，并在延迟触发时造成未授权或有害行为。',
         ['存在不可信输入、持久写入、后续读取或触发，以及与当前授权不一致的动作或策略变化。'],
         ['内容只存在于当前上下文。', '持久项有可信来源和明确用户授权。', '普通陈旧事实造成错误。']),
    _tag('LHHT-GOV-008', '高影响动作授权边界失效',
         'Consequential-action authorization erosion',
         'Harness 暴露的凭据、权限或审批流不能持续约束高影响动作，使 Agent 或其子进程能够越过原定主机、身份或人工确认边界。',
         ['可确认原定权限或审批合同、实际权限暴露、具体高影响动作，以及缺失或绕过的 gate。'],
         ['用户对同一目标和范围给出明确当前授权。', '动作在 sandbox 内且没有外部影响。']),
]

TAG_METADATA = {
    tag_id: (locus, 'harness; mapping requires task evidence',
             'Long-horizon harness taxonomy · 2026-09-07.1')
    for locus, tag_ids in [
        ('state, handoff, session persistence', ['LHHT-STATE-001']),
        ('context selection, refresh, execution memory', ['LHHT-CTX-002']),
        ('progress ledger, completion gate, role separation', ['LHHT-PROG-003']),
        ('verifier, grader, observation surfaces', ['LHHT-VER-004']),
        ('logging, tracing, provenance, implementation linkage', ['LHHT-OBS-005']),
        ('retry, checkpoint, reconciliation, restart', ['LHHT-REC-006']),
        ('memory, skills, policy/config state', ['LHHT-SEC-007']),
        ('credentials, permissions, approval gates', ['LHHT-GOV-008']),
    ] for tag_id in tag_ids
}

TAG_AUTHORITY_WEIGHTS = {tag_id: .82 for tag_id, *_ in TAGS}

TAG_SUPPORTING_SOURCES = {
    'LHHT-STATE-001': ['longhorizon-harness', 'onedayagent', 'anthropic-managed'],
    'LHHT-CTX-002': ['longhorizon-harness', 'onedayagent', 'anthropic-long-running'],
    'LHHT-PROG-003': ['longhorizon-harness', 'structagent', 'anthropic-long-running'],
    'LHHT-VER-004': ['weavebench', 'structagent', 'harnessfix', 'nist-probes'],
    'LHHT-OBS-005': ['harnessfix', 'harness-engineering', 'anthropic-managed',
                     'openai-symphony'],
    'LHHT-REC-006': ['harnessfix', 'anthropic-managed', 'unu-harness'],
    'LHHT-SEC-007': ['agentcanary', 'harnessrisk', 'unu-harness'],
    'LHHT-GOV-008': ['harnessfix', 'harnessrisk', 'openai-symphony'],
}

RESEARCH_FOUNDATION_SOURCE_IDS = list(dict.fromkeys(
    source for sources in TAG_SUPPORTING_SOURCES.values() for source in sources
))

SOURCE_SUPPORT_NOTES = {
    'longhorizon-harness': 'Source-stated problems include Task-state loss, Context rot, and coupled execution/completion assessment.',
    'onedayagent': 'Observes state-transfer failures and goal drift under accumulated constraints.',
    'structagent': 'Observes false progress commits and visually plausible but semantically incomplete states.',
    'weavebench': 'Observes that final-only grading is vulnerable to shortcuts.',
    'harnessfix': 'Defines flaws in verification, observability, lifecycle recovery, and governance.',
    'harness-engineering': 'States that voluminous trajectories can bury actionable signal.',
    'agentcanary': 'Measures memory contamination in persistent state.',
    'harnessrisk': 'Defines security problems in state persistence and action control; it does not support general capability or progress nodes.',
    'anthropic-long-running': 'Reports loss of coherence on lengthy tasks and positively biased self-evaluation.',
    'anthropic-managed': 'Reports session loss, indistinguishable infrastructure failures, and non-restartable coupled infrastructure.',
    'nist-probes': 'Calls for visibility into reasoning, tool usage, and gathered evidence.',
    'unu-harness': 'Reports interruption recovery failures and persistent memory poisoning risks.',
    'openai-symphony': 'Documents multi-run observability and a child-process credential-boundary bypass.',
}

SOURCE_SECTION_LOCATORS = {
    'longhorizon-harness': ('§1 challenges and structural limitations',
                            'https://arxiv.org/html/2608.01964#S1.p2.1'),
    'onedayagent': ('§1 long-horizon pressures', 'https://arxiv.org/html/2608.05013#S1'),
    'structagent': ('§5 Q1', 'https://arxiv.org/html/2607.11388#S5.SS0.SSS0.Px1'),
    'weavebench': ('§3 Trajectory-aware Agent as Judge',
                   'https://arxiv.org/html/2606.09426#S3.SS4.p1.1'),
    'harnessfix': ('Table II · harness flaw taxonomy',
                   'https://arxiv.org/html/2606.06324#S2.T2'),
    'harness-engineering': ('Abstract and §1', 'https://arxiv.org/html/2604.25850#Sx1'),
    'agentcanary': ('§4.3 Memory Contamination Tasks',
                    'https://arxiv.org/html/2606.10484#S4.SS3'),
    'harnessrisk': ('§2.2 Lifecycle Taxonomy',
                    'https://arxiv.org/html/2608.17597#S2.SS2'),
    'anthropic-long-running': ('Why naive implementations fall short',
                               'https://www.anthropic.com/engineering/harness-design-long-running-apps#why-naive-implementations-fall-short'),
    'anthropic-managed': ('Don\'t adopt a pet',
                          'https://www.anthropic.com/engineering/managed-agents#dont-adopt-a-pet'),
    'nist-probes': ('Overview',
                    'https://www.nist.gov/programs-projects/building-evaluation-probes-agentic-ai'),
    'unu-harness': ('Runtime-layer problem discussion',
                    'https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer'),
    'openai-symphony': ('§1 Problem Statement and credential-isolation fix',
                        'https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L203-L212'),
}

# A source can support different nodes in different sections. These per-link
# anchors override the source-level discovery locator above.
TAG_SOURCE_LOCATORS = {
    ('LHHT-STATE-001', 'longhorizon-harness'): ('§1, challenge (iii)', 'https://arxiv.org/html/2608.01964#S1.p2.1'),
    ('LHHT-STATE-001', 'onedayagent'): ('§1, state-transfer pressure', 'https://arxiv.org/html/2608.05013#S1'),
    ('LHHT-STATE-001', 'anthropic-managed'): ("Don’t adopt a pet · session loss", 'https://www.anthropic.com/engineering/managed-agents#dont-adopt-a-pet'),
    ('LHHT-CTX-002', 'longhorizon-harness'): ('§1, challenge (ii)', 'https://arxiv.org/html/2608.01964#S1.p2.1'),
    ('LHHT-CTX-002', 'onedayagent'): ('§1, context accumulation', 'https://arxiv.org/html/2608.05013#S1'),
    ('LHHT-CTX-002', 'anthropic-long-running'): ('Why naive implementations fall short · failure 1', 'https://www.anthropic.com/engineering/harness-design-long-running-apps#why-naive-implementations-fall-short'),
    ('LHHT-PROG-003', 'longhorizon-harness'): ('§1, structural limitation (ii)', 'https://arxiv.org/html/2608.01964#S1.p3'),
    ('LHHT-PROG-003', 'structagent'): ('§5, Q1 · progress commits', 'https://arxiv.org/html/2607.11388#S5.SS0.SSS0.Px1'),
    ('LHHT-PROG-003', 'anthropic-long-running'): ('Why naive implementations fall short · failure 2', 'https://www.anthropic.com/engineering/harness-design-long-running-apps#why-naive-implementations-fall-short'),
    ('LHHT-VER-004', 'weavebench'): ('§3, Trajectory-aware Agent as Judge', 'https://arxiv.org/html/2606.09426#S3.SS4.p1.1'),
    ('LHHT-VER-004', 'structagent'): ('§5, Q1 · hidden missing state', 'https://arxiv.org/html/2607.11388#S5.SS0.SSS0.Px1'),
    ('LHHT-VER-004', 'harnessfix'): ('Table II, Verification and Evaluation', 'https://arxiv.org/html/2606.06324#S2.T2'),
    ('LHHT-VER-004', 'nist-probes'): ('Overview, first paragraph', 'https://www.nist.gov/programs-projects/building-evaluation-probes-agentic-ai'),
    ('LHHT-OBS-005', 'harnessfix'): ('§I, challenge 1', 'https://arxiv.org/html/2606.06324#S1.p4'),
    ('LHHT-OBS-005', 'harness-engineering'): ('Abstract and §1', 'https://arxiv.org/html/2604.25850#Sx1'),
    ('LHHT-OBS-005', 'anthropic-managed'): ("Don’t adopt a pet · failure localization", 'https://www.anthropic.com/engineering/managed-agents#dont-adopt-a-pet'),
    ('LHHT-OBS-005', 'openai-symphony'): ('§1 Problem Statement, lines 203–212', 'https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L203-L212'),
    ('LHHT-REC-006', 'harnessfix'): ('Table II, Lifecycle and Orchestration', 'https://arxiv.org/html/2606.06324#S2.T2'),
    ('LHHT-REC-006', 'anthropic-managed'): ("Don’t adopt a pet · restart recovery", 'https://www.anthropic.com/engineering/managed-agents#dont-adopt-a-pet'),
    ('LHHT-REC-006', 'unu-harness'): ('Interruption and recovery paragraph', 'https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer'),
    ('LHHT-SEC-007', 'agentcanary'): ('§4.3, Memory Contamination Tasks', 'https://arxiv.org/html/2606.10484#S4.SS3'),
    ('LHHT-SEC-007', 'harnessrisk'): ('§2.2, State Persistence', 'https://arxiv.org/html/2608.17597#S2.SS2.p5.1'),
    ('LHHT-SEC-007', 'unu-harness'): ('Memory poisoning paragraph', 'https://unu.edu/publication/engineering-and-governing-agent-harness-technology-and-policy-framework-runtime-layer'),
    ('LHHT-GOV-008', 'harnessfix'): ('Table II, Governance and Security', 'https://arxiv.org/html/2606.06324#S2.T2'),
    ('LHHT-GOV-008', 'harnessrisk'): ('§2.2, Action Control', 'https://arxiv.org/html/2608.17597#S2.SS2.p6.1'),
    ('LHHT-GOV-008', 'openai-symphony'): ('Commit 8001b52, Context', 'https://github.com/openai/symphony/commit/8001b52e3062495a16e520e4ceaf8f9de868c4d0'),
}

TAG_SOURCE_NOTES = {
    ('LHHT-STATE-001', 'longhorizon-harness'): 'Source-stated problem: Task-state loss.',
    ('LHHT-STATE-001', 'onedayagent'): 'Observed problem: intermediate state fails to transfer across environments.',
    ('LHHT-STATE-001', 'anthropic-managed'): 'Observed problem: a coupled-container failure lost the session.',
    ('LHHT-CTX-002', 'longhorizon-harness'): 'Source-stated problem: Context rot.',
    ('LHHT-CTX-002', 'onedayagent'): 'Observed problem: goals drift under accumulated constraints.',
    ('LHHT-CTX-002', 'anthropic-long-running'): 'Observed problem: lengthy tasks lose coherence as context fills.',
    ('LHHT-PROG-003', 'longhorizon-harness'): 'Stated limitation: task execution and completion assessment remain coupled.',
    ('LHHT-PROG-003', 'structagent'): 'Observed problem: false progress commits; completion claims are proposals.',
    ('LHHT-PROG-003', 'anthropic-long-running'): 'Observed problem: agents skew positive when grading their own work.',
    ('LHHT-VER-004', 'weavebench'): 'Observed problem: final-only grading is vulnerable to shortcuts.',
    ('LHHT-VER-004', 'structagent'): 'Observed problem: a plausible screen can hide missing state.',
    ('LHHT-VER-004', 'harnessfix'): 'Defined problem: verification misses invalid artifacts and missing effects.',
    ('LHHT-VER-004', 'nist-probes'): 'Stated limitation: evaluators need visibility into tool use and gathered evidence.',
    ('LHHT-OBS-005', 'harnessfix'): 'Stated limitation: failure evidence is fragmented.',
    ('LHHT-OBS-005', 'harness-engineering'): 'Stated limitation: voluminous trajectories bury actionable signal.',
    ('LHHT-OBS-005', 'anthropic-managed'): 'Observed problem: infrastructure could not reveal where failures arose.',
    ('LHHT-OBS-005', 'openai-symphony'): 'Documented need: debug multiple concurrent agent runs.',
    ('LHHT-REC-006', 'harnessfix'): 'Defined problem: retry loops repeat ineffective actions.',
    ('LHHT-REC-006', 'anthropic-managed'): 'Observed problem: coupled infrastructure was not restartable.',
    ('LHHT-REC-006', 'unu-harness'): 'Stated problem: actions repeat after interruption.',
    ('LHHT-SEC-007', 'agentcanary'): 'Measured problem: persistent state can contain unsafe rules.',
    ('LHHT-SEC-007', 'harnessrisk'): 'Defined security problem: adversarial content is written into trusted state and reused.',
    ('LHHT-SEC-007', 'unu-harness'): 'Stated security problem: memory poisoning and procedural drift.',
    ('LHHT-GOV-008', 'harnessfix'): 'Defined problem: approval flows can be too weak.',
    ('LHHT-GOV-008', 'harnessrisk'): 'Defined security problem: sensitive actions receive insufficient validation.',
    ('LHHT-GOV-008', 'openai-symphony'): 'Documented defect: a child process could bypass a host-side credential boundary.',
}

# Retained for consumers that validate legacy report fields.
RESPONSIBILITIES = ('model', 'harness', 'environment', 'grader', 'mixed', 'unknown')
HARNESS_LAYERS = ('execution', 'tooling', 'context', 'lifecycle', 'observability',
                  'verification', 'governance')

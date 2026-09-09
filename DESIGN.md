# TiDB-All-in-One 插件设计

> 一句话：把 `tidbcloud/nutshell-skills` 里 **59 个 SKILL.md** 当作"能力插件"，本插件只提供一个**不含任何 TiDB 领域知识的路由内核**——问清目标与已知条件，检索出该调用哪些 skill，编成可审计、可回放的执行计划，然后执行。

设计基线（调研于 2026-09-04）：
- DeepSeek Harness 理论：<https://www.deepseek.com/harness/>
- 能力来源：`tidbcloud/nutshell-skills`，59 个 SKILL.md / 实际 9 个 category（platform 13、diagnosis 25、ops 7、utilities 7、daily_work 2、finops 2、growth 1、health_check 1、security 1；上游校验脚本另允许 tests/openclaw 两个当前为空的 category）

---

## 1. 从 DeepSeek Harness 学到什么

Harness 的核心命题是 **Agent = Model + Harness**：模型提供智能，Harness 提供"理解环境、使用工具、在真实场景中持续工作"的基础设施。它给出的四条可迁移结论：

| Harness 的做法 | 迁移到 TiDB-All-in-One |
|---|---|
| **Cordis 内核只管插件的加载/卸载/依赖**，不实现任何 Agent 功能 | 路由内核只做 `意图澄清 → 能力检索 → 计划 → 闸门 → 执行 → 记录`，**不写任何一条 TiDB 知识**；所有领域知识留在上游 SKILL.md |
| **一切皆插件**：model / tool / skill / session / sandbox / storage / loop / scheduling / UI 全部由插件提供 | **一切能力皆 skill**：59 个 SKILL.md 就是插件本体；内核通过 `catalog.json` 发现它们，而不是硬编码 |
| **配置层组合，不改源码** | 上游新增/改名一个 skill，只需重建 catalog（+ 可选 overlay 一行），内核零改动、零发版 |
| **append-only 会话日志**："模型看到的一切都写进 session log，包括系统提示、思维链、工具调用与结果、子 Agent 调度、**每一次上下文注入**"；recovery / fork / retrieval / replay 共享同一事件流 | `trajectory.jsonl` 记录每一次 SKILL.md 注入（哪个文件、多少 token、为什么选它），支撑 `resume / fork / replay` 与**路由质量复盘** |
| 四种 preset 模式（Standard / PTC / Minimal / Creative） | 四种运行模式：`guided / plan-only / auto / minimal` |

**这个理论为什么正好治本项目的病**（以下数字为 M0 实测，commit `dddd54f`）：59 个 skill 全量 sync 到 `~/.claude/skills/` 时，description 常驻 **6.3k token**、59 个描述互相抢自动触发，而 SKILL.md 正文合计 **199k token**（连同 `references/`、`knowledge/` 共 **553k**）。更要命的是用户（尤其 oncall 新人）根本不知道 `tikv-fast-tune` 和 `tikv-performance` 该用哪个、`o11y-metrics-api` 前面必须先跑 `o11y-auth`。把 skill 从"自动触发的常驻能力"降级为"按需按路径加载的数据"，正是 Harness 的"能力由插件提供、由内核按需装配"。

---

## 2. 四条硬约束（设计红线）

1. **内核零领域知识**。路由内核里出现任何一个 TiKV / PD / TiCDC 的专有判断，就是设计失败——那条知识应该回到某个 SKILL.md。
2. **catalog 只能生成，不能手写**。`catalog.json` 由脚本扫描 SKILL.md frontmatter 产出；人工信息只允许写在 `routing-overlay.yaml`（按 skill id 覆盖），且 overlay 缺失时必须能降级工作。
3. **计划里的每个 skill id 必须被脚本校验存在**。不信任模型输出的 skill 名——`verify-plan.mjs` 做确定性检查，防止幻觉出一个不存在的 skill。
4. **非侵入上游**。不改 `nutshell-skills` 一行。overlay 放在本插件；若上游将来愿意在 frontmatter 里加 `x-routing:` 块，builder 优先采信上游。

---

## 3. 架构

```
                    ┌─────────────────────────────────────────────┐
   用户目标 +       │              路由内核 (Kernel)               │
   已知条件  ─────▶ │  Intake → Retrieve → Plan → Gate → Execute   │ ─────▶ 结论 / 报告 / 操作
                    │                    ↓ 每一步                  │
                    └────────────────────┼────────────────────────┘
                                         ▼
                              trajectory.jsonl (append-only)
                                         │
        ┌────────────────┬───────────────┴───────┬──────────────────┐
        ▼                ▼                       ▼                  ▼
   CatalogSource     Retriever                 Gate              Reporter
   (可替换)          (关键词→向量, 可替换)     (security skill)   (可替换)
        │
        ▼
   catalog.json  ◀── build-catalog.mjs ◀── nutshell-skills/skills/**/SKILL.md
                                        ◀── routing-overlay.yaml (本插件维护)
```

五个阶段：

| 阶段 | 输入 | 输出 | 谁执行 |
|---|---|---|---|
| **Intake** 意图澄清 | 用户的目标 + 已知条件 | Task Frame（结构化槽位） | 主 agent，最多一轮追问 |
| **Retrieve** 能力检索 | Task Frame | 候选 skill ≤ 8（含理由与置信度） | 两段式检索（脚本粗筛 + 模型精排） |
| **Plan** 计划编排 | 候选 + 前置依赖图 | Plan DAG（含前置步骤、失败回退） | `tidb-planner` 子 agent（只读） |
| **Gate** 安全闸门 | Plan DAG | 放行 / 需确认 / 拒绝 | `verify-plan.mjs` + `security` skill |
| **Execute** 执行 | Plan DAG | 结论 + trajectory | 主 agent，逐步按路径加载 SKILL.md |

---

## 4. 核心数据结构

### 4.1 Capability Manifest —— `catalog.json` 条目

```jsonc
{
  "id": "diagnosis/tikv-fast-tune",          // 唯一键 = category/name
  "name": "tikv-fast-tune",
  "path": "skills/diagnosis/tikv-fast-tune/SKILL.md",
  "category": "diagnosis",
  "summary": "用确定性决策树逐层定位 TiKV 性能瓶颈",   // ≤40 token，粗筛用
  "digest_tokens": 34,                        // 常驻成本
  "full_tokens": 4180,                        // 加载成本，用于上下文预算

  // ↓ 以下由 routing-overlay.yaml 提供（上游 frontmatter 若有 x-routing 则优先）
  "intent":  ["diagnose"],                    // diagnose|inspect|operate|deploy|query|report|manage|author
  "scope":   ["dedicated", "self-hosted"],    // 适用产品线
  "subject": ["tikv", "latency", "io"],       // 主体对象
  "requires": ["platform/clinic-api"],        // 前置能力（认证/路由/取数）
  "inputs":  ["cluster_id", "time_window"],   // 必需槽位 → 反向驱动 Intake 提问
  "effect":  "read-only",                     // read-only | write-nonprod | write-prod | destructive
  "entry":   false,                           // 是否是家族入口 skill
  "family":  "tikv-oncall-handbook"           // 归属家族，用于"只推入口不推全家"
}
```

**降级规则**：overlay 缺失时，`intent/scope/subject` 由 description 关键词推断，`effect` 默认 `write-prod`（保守），`requires` 为空。新 skill 无需 overlay 也能被检索到，只是排序略差、闸门略严——这就是"配置层组合"的容错。

### 4.2 Task Frame —— Intake 的槽位

```yaml
objective:     "Starter 集群从昨天 14:00 起 P99 从 20ms 涨到 300ms"   # 必填
deliverable:   conclusion | report | action | script                  # 默认 conclusion
product_line:  dedicated | starter | essential | premium | byoc | self-hosted | unknown
target:        { org_id?, cluster_id?, pool?, jira?, changefeed? }   # org_id 就是 tenant id——TiDB Cloud 里两个词指同一个标识符，不建两个槽位
time_window:   { from, to }                                           # 诊断类必填
evidence:      ["Grafana 上 TiKV gRPC duration 同步上涨", "无变更"]     # 用户的已知条件
access:        [clinic_api_key?, github_pat?, ticloud_login?, ssh?, chrome_session?]
constraints:   { read_only: true, is_prod: true, deadline?, no_browser? }
```

**提问策略（Intake 的唯一算法）**：
1. 先用 `objective + evidence` 做一次粗筛，看候选集合。
2. **只问那些"不同答案会导致不同 skill 路径"的槽位**。例：`product_line` 会把 Serverless 路由到 `tidbcloud-serverless-pool-routing`、把 Dedicated 路由到 `clinic-api`，必问；而 `deliverable` 不影响路由，不问，用默认值。
3. 一轮最多 4 个问题，每题给候选项和"我猜是 X"。
4. 用户答不上来就标 `unknown`，**不阻塞**：在计划里写成分支——"若为 Starter 则走 s2a，若为 Dedicated 则走 s2b；第 1 步会自动判定"。

### 4.3 Plan DAG —— 计划步骤

```yaml
plan_id: p_20260904_1032
mode: guided
steps:
  - id: s1
    skill: platform/tidbcloud-serverless-pool-routing
    why: "Starter 集群需先把 cluster 解析到 shared pool 与 control_plane_info 才能取父级指标"
    inputs: { cluster_id: "10..." }
    produces: [pool, vendor_region, control_plane_info]
    effect: read-only
    gate: none
  - id: s2
    skill: platform/o11y-auth
    needs: []
    why: "o11y-metrics-api 需要 bearer token"
    effect: read-only
  - id: s3
    skill: platform/o11y-metrics-api
    needs: [s1, s2]
    why: "拉取 P99 / gRPC duration / TiKV CPU 的时间序列作为证据"
    effect: read-only
  - id: s4
    skill: diagnosis/tidb-perf-diagnosis
    needs: [s3]
    why: "入口诊断 skill：先分类症状，再决定加载哪个 knowledge 文件"
    effect: read-only
    on_branch:
      "瓶颈在 TiKV 侧": s5
      "瓶颈在 SQL/计划侧": s5b
  - id: s5
    skill: diagnosis/tikv-fast-tune
    needs: [s4]
    why: "决策树逐层定位到具体的 TiKV 内部层"
    effect: read-only
budget: { max_steps: 8, max_context_tokens: 60000 }
fallback: "若 s3 无数据 → 改走 platform/clinic-api 取数"
```

### 4.4 Trajectory —— append-only 事件流

`.tidb-aio/sessions/<session_id>/trajectory.jsonl`，每行一个事件：

```jsonc
{"ts":"...","seq":12,"type":"context_injection","source":"skills/diagnosis/tikv-fast-tune/SKILL.md",
 "tokens":4180,"reason":"plan step s5","plan_id":"p_...","step":"s5"}
```

事件类型：`intake_question / intake_answer / catalog_query / candidate_set / plan / gate_decision / context_injection / tool_call / tool_result / branch / report / fork`。

三个直接收益：
- `resume`：断线后从最后一个成功 step 继续，不重跑取数。
- `fork`：从第 4 步分叉试另一条诊断路径，对比两条路径的结论。
- **路由复盘**：把 `candidate_set` + 用户最终实际用了哪个 skill 对比，产出 overlay 的修订建议——这是让路由越用越准的唯一闭环。

---

## 5. 关键机制

### 5.1 两段式检索（解决"59 个 skill 塞不进上下文"）

> M0 实现说明：中文检索需要 `config/lexicon.yaml`（中文词 → 英文 token）。上游 SKILL.md 全是英文，中文目标不做映射时粗筛得分全为 0，会次次落到兜底排序。这是原设计漏掉的一环。

- **粗筛（确定性脚本，0 token 思考）**：按 `product_line → scope` 过滤，按 `intent` 过滤，再对 `objective + evidence` 做 BM25/关键词打分，取 Top-12。
- **精排（模型，只看摘要）**：把 12 条 `summary`（≈ 500 token）交给 `tidb-planner` 子 agent 排序、去重同家族（同 `family` 只留 `entry:true` 的入口）、给出 Top-3~5 与理由。
- **加载（按需）**：只有进入 Plan 的 skill 才 `Read` 完整 SKILL.md。

上下文账（M0 实测）：常驻摘要 **1843 token**；全量 description 常驻 **6311 token**；全部 SKILL.md 正文 **198944 token**。一次典型诊断（走查一）计划 5 步，预估注入 **37k token**。真正的收益不只是省下 4.5k 常驻，而是不必让 59 个描述互相抢触发、也不必把 199k 正文留在可能被加载的路径上。

### 5.2 skill 安装策略：混合模式（推荐）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 全量 sync 到 `~/.claude/skills` | 原生自动触发 | 18k 常驻、59 个 description 互相抢触发、用户仍不知道用哪个 | ✗ |
| 全部按路径加载（skill-as-data） | 上下文最省、注入可审计 | 失去自动触发 | 部分采用 |
| **混合** | 只 sync `security` + 3~5 个高频入口 skill（`tidb-perf-diagnosis`、`tikv-oncall-handbook`、`pd-oncall-handbook`、`devops-api`）+ 本插件的 router skill；长尾 50+ 个由 router 按路径 `Read` | 需要 catalog 保持新鲜 | **✓ 采用** |

对应 `./sync-skills.sh --skill diagnosis.tidb-perf,security,...`——上游脚本已经支持按 category/prefix 过滤，不用改。

### 5.3 前置依赖图（自动补步骤）

catalog 的 `requires` 形成一张有向图，Planner 对每个选中的 skill 做拓扑闭包，自动把认证/路由类前置插到计划前面。已知的几条边（写进 overlay 的初始值）：

```
platform/o11y-metrics-api      → requires platform/o11y-auth
platform/o11y-data             → requires platform/o11y-auth
platform/o11y-data-export      → requires platform/o11y-auth
diagnosis/tidbcloud-serverless-daily-inspection
                               → requires platform/tidbcloud-serverless-pool-routing
diagnosis/tikv-fast-tune       → requires platform/clinic-api (或 o11y-metrics-api)
diagnosis/ticdc-health-inspection → requires platform/clinic-api
ops/manage-ticdc-changefeeds   → requires platform/devops-api (取 changefeed 元数据)
utilities/oncall-toolkit       → requires platform/jira-api
daily_work/tcoc-incident-review→ requires platform/jira-api
```

这解决了新人最常踩的坑：直接读 `o11y-metrics-api` 却没有 token。

### 5.4 安全闸门

复用上游 `skills/security/SKILL.md` 作为判定知识，闸门本身是确定性的：

| step.effect | guided | auto |
|---|---|---|
| `read-only` | 直接执行 | 直接执行 |
| `write-nonprod` | 展示命令，确认后执行 | 确认后执行 |
| `write-prod` | 展示命令 + 影响面 + 回滚方案，确认后执行 | **拒绝**，降级为 plan-only |
| `destructive` | 永不自动执行，只输出人工执行清单 | 拒绝 |

`constraints.read_only=true`（默认）时，计划里任何非 read-only 步骤直接被剔除并在报告里说明"这些动作需要你手动执行"。

### 5.5 能力缺口 → 反哺 create-skill

若精排后 Top-1 置信度低于阈值，或候选全是"沾边但不覆盖"，内核不要硬凑：
1. 明确输出"nutshell-skills 目前没有覆盖 X"；
2. 给出最接近的 2 个 skill 和它们缺的部分；
3. 把这次的 Task Frame 写进 `.tidb-aio/gaps.jsonl`；
4. 提议调用上游 `finops/create-skill` 起草新 skill。

**缺口日志是这个插件最有价值的副产品**——它用真实提问告诉你 skill 库该往哪长。

### 5.6 计划校验（不信任模型）

> M1 实测：六条规则各有一个 fixture 反例（`eval/fixtures/plan-*.yaml`），全部按预期拒绝；`plan-good.yaml` 与 `plan-gated-write.yaml` 按预期放行。

`verify-plan.mjs` 在 Gate 之前跑：
- 每个 `steps[].skill` 必须命中 `catalog.json` 的 id（否则报错并回退重规划）；
- `needs` 无环；
- `requires` 闭包已满足；
- `effect` 与 `constraints` 相容；非只读计划必须把 `security` 闸门 skill 排在第一个写步骤之前；
- skill 的 `scope` 必须包含本次 `product_line`（拦"误入无关产品线"）；
- `Σ full_tokens ≤ budget.max_context_tokens`，超了就要求 Planner 削减步骤。

---

## 6. 运行模式（对应 Harness 的 preset）

| 模式 | 触发 | 行为 | 适用 |
|---|---|---|---|
| **guided**（默认） | `/tidb <目标>` | Intake 追问 → 出计划 → 确认 → 逐步执行 | 日常诊断/运维 |
| **plan-only** | `/tidb plan <目标>` | 只产出计划与理由，不执行 | oncall 新人当"地图"；review 别人的排查思路 |
| **auto** | `/tidb auto <目标>` | 槽位齐备且全 read-only 时一路跑到底 | 定时巡检、批量 |
| **minimal** | `/tidb which <目标>` | 跳过 Intake，直接答"用哪 3 个 skill、为什么、什么顺序" | "我该用哪个 skill" 的秒答 |

---

## 7. 目录结构与文件清单

```
TiDB-All-in-One/
├── .claude-plugin/
│   ├── plugin.json                    # 插件元信息
│   └── marketplace.json               # 可选：作为 marketplace 分发
├── commands/
│   ├── tidb.md                        # /tidb <目标>        guided
│   ├── tidb-plan.md                   # /tidb plan          plan-only
│   ├── tidb-which.md                  # /tidb which         minimal
│   ├── tidb-resume.md                 # /tidb resume [id]   从 trajectory 恢复
│   └── tidb-catalog.md                # /tidb catalog       重建/查看/诊断 catalog
├── skills/
│   ├── tidb-aio-router/SKILL.md       # 路由方法本身（唯一常驻的本插件 skill）
│   ├── tidb-aio-intake/SKILL.md       # 槽位定义 + 提问策略
│   └── tidb-aio-trajectory/SKILL.md   # 事件格式 + resume/fork 语义
├── agents/
│   └── tidb-planner.md                # 只读子 agent：候选精排 + 出 Plan DAG（保护主上下文）
├── config/
│   ├── routing-overlay.yaml           # ★ 唯一需要人工维护的文件
│   ├── prerequisites.yaml             # 前置依赖边（也可并入 overlay）
│   └── settings.json                  # nutshell-skills 路径、预算、默认模式
├── scripts/
│   ├── build-catalog.mjs              # SKILL.md → catalog.json
│   ├── retrieve.mjs                   # 粗筛：过滤 + BM25 → Top-12
│   ├── verify-plan.mjs                # 计划确定性校验
│   └── trajectory.mjs                 # 追加/查询/fork 事件流
├── catalog/
│   └── catalog.json                   # 生成物，入库便于 diff review
├── eval/
│   ├── routing-cases.yaml             # 30+ 真实目标 → 期望 skill 集合
│   └── run-eval.mjs                   # 打分：Top-1 命中率 / Top-3 召回 / 前置补全率
├── hooks/
│   └── hooks.json                     # SessionStart 注入 catalog 摘要；PreToolUse 记录注入事件
└── DESIGN.md
```

**扩展点（"插件的插件"）**：`CatalogSource / Retriever / Planner / Gate / Executor / Reporter / TrajectoryStore` 各自是一个明确的输入输出契约。想把 `retrieve.mjs` 从 BM25 换成向量检索，只需保证"输入 Task Frame、输出候选数组"不变，其它六个部件一行不动——这就是 Harness 说的"在配置层替换能力"。

---

## 8. 一个完整走查

**用户输入**：`/tidb 我们一个集群昨天下午开始变慢了`

**Intake**（只问会改路由的 3 个）：
1. 产品线是 Starter/Essential 还是 Dedicated？→ `Starter`
2. cluster ID / 集群名？→ `1037...`
3. 慢在哪一层——SQL 延迟、连接、还是写入卡？有没有变更？→ `P99 20ms→300ms，无变更`

**粗筛**（脚本，scope=starter 过滤掉 dedicated 专属的 `ru-limit-inspection`、`tidbcloud-dedicated-daily-inspection`、`dedicated-cloud-diag` 等）→ 12 候选。

**精排**（planner 子 agent，同家族只留入口）→ `tidb-perf-diagnosis`（入口）、`tikv-fast-tune`、`o11y-metrics-api`、`tidbcloud-serverless-pool-routing`。

**依赖闭包** → 自动补 `o11y-auth`，并把 `pool-routing` 提到最前。

**Plan**（5 步，全 read-only，预计注入 ~14k token）→ 用户确认。

**Execute** → 逐步按路径 `Read` SKILL.md，每次注入写进 trajectory。

**输出** → 结论 + 证据（指标截图/PromQL 结果）+ 走过的 skill 路径 + 「若结论不对，从第 4 步 fork 试 SQL 侧分支」。

第二个例子（跨类）：`/tidb TCOC 上这个 changefeed 报延迟，要不要升级` → `platform/jira-api`（读工单）→ `platform/devops-api`（changefeed 元数据 → 数字 ID）→ `diagnosis/ticdc-health-inspection`（架构判定 + 指标规则）→ `ops/manage-ticdc-changefeeds`（若需变更，`write-prod` 走闸门）→ `daily_work/tcocp-rca-writer`（若需 RCA）。

---

## 9. 评测：怎么知道路由是对的

`eval/routing-cases.yaml`：

```yaml
- id: c07
  goal: "Starter 集群 P99 从 20ms 涨到 300ms，无变更"
  frame_hints: { product_line: starter }
  expect_must:  ["diagnosis/tidb-perf-diagnosis"]
  expect_any:   ["diagnosis/tikv-fast-tune", "platform/o11y-metrics-api"]
  expect_never: ["diagnosis/ru-limit-inspection"]      # dedicated-only，选中即扣分
  expect_prereq:["platform/o11y-auth", "platform/tidbcloud-serverless-pool-routing"]
```

四个指标：**Top-1 命中率**、**Top-3 召回**、**前置补全率**、**误入无关产品线率**。

> M4 补充：`lexicon-audit.mjs` 跑完 43 例语料后给出一个反直觉但重要的结论——剩下的弱信号**不是词表缺口，是 overlay 的 `subject` 缺口**。`o11y-metrics-api` 的原文只说 metrics/prometheus/promql，从不提组件名，而运维问的是"TiKV CPU 指标"。把它实际服务的组件补进 `subject` 后，该例从 weak 变 strong，43 例零回归。词表能治的是"同一件事的中英说法"，治不了"skill 自己没说过这个词"。
>
> M2 实测与两处修正——eval 一上来就 18/35，暴露了两个系统性缺陷，都不是个别 case 的问题：
> 1. **家族入口永远压过叶子**。原设计"同家族只推入口"让 top1 恒为 handbook，5 个 case 全挂。改为**叶子在前、入口紧随其后**：运维报的是具体症状（"日志里有 SIGSEGV"），每次都先绕一趟 handbook 是白花一跳；入口仍在第二位兜底。
> 2. **intent 权重太弱**（原 ×1.25）。"暂停 changefeed" 和 "CDC 把 TiKV 打 panic" 词汇高度重叠却要去不同 skill，而 diagnosis 类 handbook 又多又关键词密集，会淹没所有 operate/manage 查询。改为**匹配 ×1.6、不匹配 ×0.65**。
>
> 修正后 35/35。另外 `expect_never` 的语义被收窄为"scope 违例"——把"合理近邻"也算错是过严，剪枝近邻是第二段模型排序的职责。用例来源直接抄真实 oncall 工单标题——每次 `gaps.jsonl` 里的新缺口，修完后都补一条用例。目标：M2 结束时 Top-3 召回 ≥ 0.9、误入率 ≤ 0.05。

---

## 10. 实施路线

| 里程碑 | 内容 | 判据 |
|---|---|---|
| **M0** ✅ 已完成 | `build-catalog.mjs` + `catalog.json` + `digest.md` + `retrieve.mjs`（提前实现）+ `/tidb` guided + `/tidb-catalog` + router skill + `lexicon.yaml`（中文检索，非计划内但必需）；overlay 实际覆盖 59/59 | `make smoke` 通过：catalog 零告警、两个走查例子路由正确且前置自动补全 |
| **M1** ✅ 已完成 | `tidb-planner` 精排子 agent + `verify-plan.mjs` + 前置依赖闭包 + 安全闸门 + `trajectory.mjs`（写入 / `resume` / `fork`）+ `/tidb-resume` | `make smoke` 20 项全绿：六种计划失败模式全部拦下、两个正确计划放行、trajectory 写入→resume→fork 往返一致 |
| **M2** ✅ 已完成 | `eval/routing-cases.yaml`(35 例) + `run-eval.mjs` + `replay` + `gaps`（改为 trajectory 事件，不再单独落 `gaps.jsonl`）+ `/tidb-plan`、`/tidb-which` 两个模式 + `catalog-drift.yml` 每日 CI | 实测 Top-1 100%、Top-3 召回 100%、前置补全 100%、误入产品线 0%、兜底率 5.7%；阈值已收紧到 0.85/0.95/1.0/0.05 防回归 |
| **M3** ✅ 已完成 | 步骤级 `effect` 收窄（`effect_min` 白名单 + 强制 justification）+ 概念级 `signal` 判定 + `sharpen` 槽位提示 + 负例/近邻例扩到 43 例 | `make smoke` 27 项全绿；eval 43/43，五项指标（含"知道自己不知道"）全部达标 |
| **M4** ✅ 部分完成 | 检索器接缝（`scripts/retrievers/` + `CONTRACT.md` + 配置切换）、`lexicon-audit.mjs`（按"实际造成弱信号"排序而非词频）、OpenCode/Codex 适配器生成 | 抽取 BM25 到独立模块后 43 例排序**零变化**，接缝可换性得证；`make smoke` 35 项全绿 |
| **M5**（未做） | 语义/向量检索 | 需要 embeddings 端点，本插件目前不依赖网络。接缝已就绪：新增一个实现 CONTRACT 的文件 + 一行配置。这是"把备份恢复到新集群"这类零关键词证据查询的唯一真解 |

**CI**：一个 workflow 定时拉 `nutshell-skills` HEAD，重建 catalog，diff 非空则开 PR，并对 overlay 里已失效的 skill id 报错——这是防止"配置层"腐烂的唯一手段。

---

## 11. 风险与取舍

| 风险 | 缓解 |
|---|---|
| **catalog 与上游漂移**（改名/移动 category） | CI 定时重建 + overlay 孤儿 id 报错；catalog.json 入库以便 diff review |
| **Intake 变成审讯** | 硬上限：一轮 ≤ 4 问，且只问改变路由的槽位；答不上来标 unknown 走分支 |
| **模型幻觉 skill 名** | `verify-plan.mjs` 确定性校验，命中失败即重规划 |
| **同家族 skill 互相抢**（25 个 diagnosis 里 12 个是 tikv-*） | catalog 的 `family` + `entry` 字段：同家族只推入口，入口 SKILL.md 自己的 Routing Guide 负责下一跳（复用上游已有模式） |
| **越权/误操作** | 默认 `read_only: true`；`write-prod`/`destructive` 永不自动执行 |
| **`effect` 是 skill 级而非操作级**（M2 走查发现）：`platform/jira-api` 因为能升级工单而被标 `write-nonprod`，于是"只读一张工单"也会被只读约束拦下 | 当前只能整体解除只读并走闸门。M3 应支持步骤级 `effect_override` + 强制 `justification`，且任何 override 都仍需闸门确认——不能让模型靠声明绕过 |
| **signal 不能当正确性用**（M3 eval 发现）：中文短句本来就没多少英文重合，`备份恢复到新集群` 路由正确但 signal=none，`Starter 指标` 路由正确但 signal=weak | signal 只表示"关键词重合强度"，只在负例上做断言。弱/无信号的含义是"planning 前先确认"，绝不是"直接记缺口"。真正的解法是向量检索（M4） |
| **无 intent/product_line 时排序明显变差**（M2 走查发现）：同一个"changefeed 延迟"问题，minimal 模式下 `ticdc-health-inspection` 从第 1 掉到第 3 | 这正是 Intake 存在的理由；`/tidb-which` 的输出里必须写明"补上产品线会改变答案" |
| **上下文爆炸** | 预算校验 + 逐步加载 + 子 agent 承担精排 |
| **过度设计**（内核开始长知识） | 红线 1：任何领域判断 code review 时打回到 SKILL.md |

---

## 12. 一句话总结

Harness 的洞察不是"多写插件"，而是 **把内核缩小到只剩装配逻辑，让能力全部外置且可替换**。对 TiDB-All-in-One 来说，这意味着：**不要再写第 60 个 skill 来教人用前 59 个**——写一个不懂 TiDB 的路由器，让它读 catalog、问清目标、编排计划、记录轨迹。上游每加一个 skill，它自动变强；每一次路由失败，都在 `gaps.jsonl` 里留下下一个 skill 的需求说明书。

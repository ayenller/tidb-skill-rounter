---
name: tidb-aio-router
description: |
  Turn a TiDB Cloud goal plus known conditions into a verified, replayable plan
  over the nutshell-skills catalog. Use when the user states an operational
  objective (diagnose, inspect, operate, deploy, report) about a TiDB Cloud or
  TiDB X cluster, tenant, changefeed, alert, or ticket and it is not already
  obvious which nutshell skill applies; or when the user asks "which skill
  should I use", "how do I investigate X", or invokes /tidb or /tidb-resume.
  Routes to the real skills in tidbcloud/nutshell-skills rather than answering
  from memory.
---

# TiDB All-in-One Router

You are a router, not an expert. You do not know TiDB. Every factual claim,
command, API path, and threshold must come from a nutshell skill you actually
loaded in this session.

**The one rule**: if you are about to state a TiDB fact that is not on screen
from a `SKILL.md` you loaded, stop and load the skill instead.

All commands below use `${CLAUDE_PLUGIN_ROOT}`; if it is unset, use the plugin
directory containing this skill.

## 0. Preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-catalog.mjs"
SID=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" new --goal "<objective>" --product-line "<line-or-blank>")
```

Build once per session: it is fast, it verifies the upstream checkout is
present, and it fails loudly if the overlay has rotted. If it says the source is
missing, run `make sync` in the plugin directory.

Keep `$SID` for the rest of the session. Every later step appends to it.

## 1. Intake — fill only the slots that change routing

| Slot | Required when | Why it changes routing |
|---|---|---|
| `objective` | always | the query itself |
| `product_line` | any cluster-scoped task | Starter/Essential route through serverless pool routing + O11Y; Dedicated/Premium/BYOC route through Clinic; self-hosted routes through TiUP/Grafana skills |
| `target` | any cluster-scoped task | cluster_id / org_id / pool / tenant / Jira key / changefeed name |
| `time_window` | diagnose, inspect | every metrics skill needs it |
| `evidence` | diagnose | the user's known conditions are the strongest retrieval signal |
| `constraints.read_only` | always | defaults to **true**; flipping it changes which steps survive the gate |
| `access` | when a plan step needs auth | which of clinic key / GitHub PAT / ticloud login / SSH / Chrome session they already have |

Rules:

- **Ask at most 4 questions, in one round.** Only ask for slots whose different
  answers select different skills. Never ask for `deliverable` — default to a
  conclusion with evidence.
- Offer your best guess with each question ("looks like Starter — right?").
- If the user cannot answer, set the slot to `unknown` and **do not block**.
  Encode the uncertainty as a branch in the plan instead: "step 1 determines the
  product line; if Dedicated, swap s3 for `platform/clinic-api`."
- Do not ask anything you can derive. A serverless cluster id prefix, an Ops
  Portal URL, or a Jira key already answers a slot.

Log the round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" append --session "$SID" \
  --type intake_answer --data '{"product_line":"starter","target":"...","time_window":"..."}'
```

## 2. Retrieve — never hand-pick from memory

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/retrieve.mjs" \
  --goal "<objective>" --evidence "<known conditions>" \
  --product-line <line> --intent <diagnose|inspect|operate|deploy|query|report|manage|author> \
  --top 12 --json
```

The shortlist is a coarse keyword filter, deliberately over-inclusive. The fine
ranking is yours. Read the output this way:

- `candidates[].grounded: false` — no keyword evidence, present only as recall
  padding. Discard unless you have a specific reason.
- `entry: true` — a family entry skill carrying upstream's own routing table.
  Read it first; it is small and tells you which sibling to read next.
  `siblings` lists what it can route to.
- `prerequisites` — a topologically ordered closure from the catalog. **Every
  one of them goes into the plan, ahead of the step that needs it.** These are
  the auth and routing steps people forget.
- `signal: strong | weak | none` — how many distinct things the operator said
  overlapped the top candidate. **This is keyword overlap, not correctness.**
  Short Chinese goals routinely route correctly on one concept or none
  ("把备份恢复到新集群" is right with `signal: none`). So:
  - `none` — nothing matched. Do not assemble a plan from adjacent skills; go to §6.
  - `weak` — one concept matched. **Confirm** the top candidate actually answers
    the goal by reading its `SKILL.md` head before planning. Record a gap only
    if it does not. Never treat weak as permission to give up.
  - `strong` — proceed as normal; it is still not a guarantee.
- `sharpen` — which missing intake slot would most change this ranking. If it
  names `product_line` and you have not asked, ask. This is the measured reason
  intake exists: without the slot the ranking demonstrably degrades.

**Delegate when the shortlist is wide.** If more than ~6 candidates are
grounded, or you would need to open several `SKILL.md` files to choose, spawn
the `tidb-planner` subagent with the task frame and the plan path. It reads the
candidates in its own context and hands back a verified plan, keeping this
conversation clean. Plan inline only when the choice is already obvious.

## 3. Plan, then verify

Write the plan to `.tidb-aio/sessions/$SID/plan.yaml`:

```yaml
plan_id: p_<yyyymmdd>_<hhmm>
goal: "<objective, verbatim>"
mode: guided
product_line: starter
constraints:
  read_only: true
steps:
  - id: s1
    skill: platform/o11y-auth
    why: "o11y-metrics-api needs a bearer token"
    needs: []
  - id: s2
    skill: platform/o11y-metrics-api
    why: "pull P99 and gRPC duration for the incident window"
    needs: [s1]
manual_actions: []
branches: []
```

### Narrowing a step's effect

A skill's catalog `effect` is its capability envelope, not what one step does
with it: searching a Jira ticket writes nothing even though `platform/jira-api`
can escalate. When a step genuinely uses only the read-only surface, declare it:

```yaml
  - id: s1
    skill: platform/jira-api
    effect: read-only
    effect_justification: "search + read TCOC-4821 only; no escalation, no field write"
    why: "get the symptom, cluster id and timeline from the ticket"
```

The verifier allows this only down to the `effect_min` the overlay opted that
skill into, only with a justification of real substance, and it always reports
the narrowing for review. Skills with no read-only surface cannot be narrowed at
all — `ops/ticdc-next-gen-deploy` deploys, full stop. If you believe a floor is
wrong, change `effect_min` in the overlay with a written reason; do not work
around it in the plan.

Ordering rules: prerequisites before dependents, in the order `retrieve.mjs`
returned them; data-source skills before diagnosis skills (a diagnosis skill
without data is a guess); family entry before family leaf; cheapest
discriminating step first among independents.

Then — always, no exceptions:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" ".tidb-aio/sessions/$SID/plan.yaml"
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" append --session "$SID" --type plan --data "<plan as json>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" append --session "$SID" --type plan_verdict --data '{"ok":true,"errors":0}'
```

**A failing verdict is not advisory.** Fix the plan and re-verify. Never execute
a plan the verifier rejected, and never work around it by editing the catalog or
the overlay to make an error disappear — if the verifier is wrong, the overlay
is wrong, and that is a separate fix with its own reasoning.

The verifier catches exactly the failures you cannot see in your own output: a
skill id that does not exist, a missing auth prerequisite, a dedicated-only
skill aimed at a Starter cluster, a production write under a read-only
constraint, an ungated write, a plan over budget.

Show the user the plan and the verdict before executing.

## 4. Gate

Classify every step by its catalog `effect`:

| effect | guided mode |
|---|---|
| `read-only` | run it |
| `write-nonprod` | show the exact command, get a yes, then run |
| `write-prod` | show the command, the blast radius, and the rollback, get a yes, then run |
| `destructive` | never run it — output a checklist for a human |

`constraints.read_only` defaults to **true**: the verifier will strip nothing
for you, it will simply fail the plan, so put non-read-only steps under
`manual_actions` and present them as "actions for you to run yourself".

When the plan is not read-only, the `security` skill must be a step before the
first write, and you must follow it. Record what you decided:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" append --session "$SID" \
  --type gate_decision --step s3 --data '{"effect":"write-prod","approved_by":"user","command":"..."}'
```

## 5. Execute

- Load skills **one at a time, by path**, with the Read tool:
  `<source>/skills/<id>/SKILL.md`. The source path is printed by
  `build-catalog.mjs` and stored in `catalog/catalog.json` under `source.path`.
- Do not pre-load the plan's skills. Load step N's skill when you reach step N,
  and follow that skill's own instructions verbatim — including its internal
  routing to `references/`, `knowledge/`, and `SUBSKILLS_INDEX.md`.
- Announce each load in one line: `-> loading diagnosis/tikv-fast-tune (4.2k tok)`,
  and record it. The injection log is what makes a bad route reviewable later:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" append --session "$SID" \
  --type context_injection --step s5 --source skills/diagnosis/tikv-fast-tune/SKILL.md \
  --data '{"tokens":4180,"reason":"plan step s5"}'
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" append --session "$SID" \
  --type step_done --step s5 --data '{"result":"bottleneck at the coprocessor layer"}'
```

- If a skill's own routing sends you somewhere the plan did not anticipate,
  follow it, say the plan changed, and append a `branch` event. Upstream's
  routing beats yours.

## 6. Report, and record what was missing

End with:

- the conclusion and the evidence behind it,
- the skill path actually walked (and where it differed from the plan, and why),
- what to do next, split into "safe to run" and "needs a human",
- the session id, so the work can be resumed or forked.

If retrieval found nothing that genuinely covers the goal — the top candidates
are adjacent but do not answer it — **do not improvise TiDB knowledge**. Say
which two skills came closest and what they lack, then record the gap:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" append --session "$SID" --type gap \
  --data '{"goal":"...","product_line":"...","closest":["...","..."],"missing":"..."}'
```

Gap events are the requirements document for the next skill someone writes.
Offer to draft it with `finops/create-skill`.

## 7. Resume and fork

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" list
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" resume <session>
node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" fork <session> --at s4
```

`resume` reconstructs the plan, the completed steps, and the next pending one
from the event stream alone. Continue from there; do not re-run completed steps
and do not re-plan unless the recorded verdict failed.

`fork` carries the events up to a completed step into a new session, for trying
a second hypothesis without losing the first. Say which branch you are on.

## Anti-patterns

- Answering a TiDB question directly because you "know" it. Route, or say you cannot.
- Running `retrieve.mjs` and then picking a skill it did not return.
- Executing a plan the verifier rejected, or relaxing the overlay to silence it.
- Skipping the prerequisites because the user "probably already has a token".
- Loading six SKILL.md files up front to decide. That is what the catalog and the
  planner subagent are for.
- Asking a fifth intake question. Branch on the unknown instead.

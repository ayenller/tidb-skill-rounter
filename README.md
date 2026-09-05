# TiDB All-in-One

A goal-driven router over [`tidbcloud/nutshell-skills`](https://github.com/tidbcloud/nutshell-skills).

State what you are trying to do and what you already know. The plugin works out
**which of the 59 nutshell skills to invoke, in what order**, fills in the auth
and routing prerequisites people forget, gates anything that writes, and then
executes step by step — loading one `SKILL.md` at a time instead of keeping all
of them in context.

Design rationale and the full architecture: [DESIGN.md](DESIGN.md).

## Why

Installing all 59 skills costs roughly **199k tokens** of `SKILL.md` (553k with
their bundled `references/` and `knowledge/`), and still leaves you guessing
whether a TiKV latency problem belongs to `tikv-fast-tune` or `tikv-performance`
— or that `o11y-metrics-api` is useless until you have run `o11y-auth` first.

This plugin keeps a **1.8k-token digest** resident and loads the full skill only
once the plan selects it.

## Install

```bash
git clone <this repo> TiDB-All-in-One && cd TiDB-All-in-One
make sync      # clone tidbcloud/nutshell-skills into .cache/
make catalog   # generate catalog/catalog.json + catalog/digest.md
make smoke     # M0 acceptance
```

Then add the directory as a Claude Code plugin. Point it at an existing
checkout instead of `.cache/` with either:

```bash
export NUTSHELL_SKILLS_PATH=~/lc/nutshell-skills
```

or `nutshellPath` in `config/settings.json`. The resolver also recovers the
checkout by following a live symlink under `~/.claude/skills/`.

## Use

```
/tidb Starter 集群昨天下午开始变慢，P99 从 20ms 涨到 300ms
/tidb-plan  changefeed 同步延迟要怎么查     # plan only, nothing executed
/tidb-which TiKV 一直 OOM                   # just "which skill", in seconds
/tidb-resume                               # list sessions, continue an open one
/tidb-catalog digest
/tidb-catalog changefeed 同步延迟          # shortlist only, no planning
```

Or from a shell:

```bash
node scripts/retrieve.mjs --goal "changefeed 同步延迟" --product-line dedicated --top 6
```

```
  #  score  effect        skill                                          why
  1   96.3  write-nonprod    platform/jira-api                            matched: jira, tcoc, ticket
  2  61.79  read-only     * diagnosis/ticdc-health-inspection            matched: changefeed, replication, lag
  3  58.29  read-only       diagnosis/tikv-cdc                           matched: cdc, changefeed, lag

prerequisites (auto-inserted, in order):
  platform/clinic-api                           required by diagnosis/ticdc-health-inspection
```

## How it is put together

| Piece | What it is |
|---|---|
| `catalog/catalog.json` | **generated** from upstream `SKILL.md` frontmatter — never edit |
| `catalog/digest.md` | the 1.8k-token resident summary |
| `config/routing-overlay.yaml` | the **only** hand-maintained file: scope, effect, prerequisites, families |
| `config/lexicon.yaml` | Chinese goal → English skill vocabulary, so coarse retrieval survives Chinese input |
| `scripts/build-catalog.mjs` | scanner + validator; fails loudly on orphaned overlay ids |
| `scripts/retrieve.mjs` | deterministic coarse filter (stage 1 of 2) |
| `scripts/verify-plan.mjs` | deterministic plan checker — the model proposes, this decides |
| `scripts/trajectory.mjs` | append-only session log; `resume`, `fork`, `replay`, `gaps` are reconstructed from it |
| `scripts/run-eval.mjs` | routing eval over `eval/routing-cases.yaml` |
| `skills/tidb-aio-router/SKILL.md` | the procedure the agent follows; stage 2 fine ranking is the model's job |
| `agents/tidb-planner.md` | read-only subagent that fine-ranks and emits a verified plan |
| `commands/tidb.md` | `/tidb`, guided mode; also `/tidb-catalog`, `/tidb-resume` |

The router contains **no TiDB knowledge**. If a TiDB fact ever ends up in this
repo outside `config/`, it belongs in an upstream skill instead.

## Adding a skill

Nothing to do. `make catalog` picks up anything new upstream. Add an entry to
`config/routing-overlay.yaml` only to improve its ranking, declare its
prerequisites, or mark it as writing to production — a skill with no overlay
entry is still catalogued and still retrievable.

## What the verifier catches

A plan is checked before anything executes. `make smoke` proves each rejection:

| Failure | Caught by |
|---|---|
| a skill id the model invented | catalog membership, with near-miss suggestions |
| `o11y-metrics-api` without `o11y-auth` | product-line-aware prerequisite closure |
| a dedicated-only skill aimed at a Starter cluster | scope check |
| a production write under `read_only: true` | effect vs constraints |
| claiming a writing skill is "read-only" without grounds | narrowing is opt-in per skill (`effect_min`) and needs a written justification |
| an ungated write | the `security` skill must precede the first write |
| a plan over budget | step count and injected-token totals |

```bash
make verify PLAN=eval/fixtures/plan-hallucinated-skill.yaml
# ERROR  step s1: skill 'diagnosis/tikv-latency-analyzer' is not in the catalog
# VERDICT: fail - re-plan, do not execute
```

## Sessions

Every run appends to `.tidb-aio/sessions/<id>/trajectory.jsonl` — the intake
answers, the shortlist, the plan and its verdict, every `SKILL.md` injection
with its token cost and the reason it was loaded, and each completed step.

```bash
make sessions
node scripts/trajectory.mjs resume s_20260905_0933_85f0
node scripts/trajectory.mjs fork   s_20260905_0933_85f0 --at s4   # try a second hypothesis
```

## Is the routing any good?

```bash
make eval
```

Goals stated the way an operator states them, scored against what the shortlist
must contain:

| metric | measured | gate |
|---|---|---|
| top-1 hit | 100% | >= 85% |
| top-3 recall | 100% | >= 95% |
| prerequisites inserted | 100% | 100% |
| wrong product line | 0% | <= 5% |
| knows when it does not know | 100% | 100% |
| coarse-filter fallback | 11.6% | — |

43 cases: 35 real goals, 4 near-miss pairs that differ only by intent or product
line, and 4 that **no skill covers** — because a router that always produces a
confident top 3 is a random skill generator with good manners.

**Read that honestly**: the cases and the ranker were written by the same author,
so 100% measures internal consistency, not generalisation. The score becomes
meaningful only as cases arrive from recorded gap events and real oncall
tickets. What the run already earned is real, though — every eval run so far has
found a defect in the router rather than in the cases:

- first run, 18/35: family entries always outranked the specific leaf, and
  intent was weighted too weakly to separate "pause this changefeed" from "why
  did CDC panic TiKV";
- adding negative cases: a goal with **zero** real overlap ("evaluate migrating
  TiDB to PostgreSQL") scored as a confident match, because one Chinese word
  expanding into three English tokens was counted as three pieces of evidence.
  Signal is now counted per *concept*, not per token;
- adding near-miss pairs: `manage-ticdc-changefeeds` was missing the `query`
  intent that its own upstream description documents, and the lexicon mapped
  恢复 to both `restore` and `recovery`, pulling backup/restore goals toward the
  TiKV unsafe-recovery handbook.

One thing the eval also settled: `signal` measures keyword overlap, **not**
correctness. Short Chinese goals route correctly on one concept of overlap or
none at all, so signal is asserted only on the negative cases and must never
gate execution by itself.

## Status

M0-M3 complete; `make smoke` runs 27 checks and includes the eval.

Implemented: catalog build and validation, overlay, bilingual coarse retrieval,
concept-level signal, family collapse, prerequisite closure, plan verification,
step-level effect narrowing, the security gate, append-only trajectory with
resume / fork / replay / gaps, the `tidb-planner` subagent, four modes
(`/tidb`, `/tidb-plan`, `/tidb-which`, `/tidb-resume`), `/tidb-catalog`, the
routing eval, and a daily CI job that rebuilds the catalog against upstream HEAD
and opens a drift PR.

Next: vector retrieval to replace BM25 — the standing answer to short Chinese
goals that route correctly with no keyword evidence — and OpenCode/Codex command
adapters. Both swap one component without touching the other six. See
DESIGN.md §10.

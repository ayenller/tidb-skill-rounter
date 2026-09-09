# TiDB Skill Router

A goal-driven router over [`tidbcloud/nutshell-skills`](https://github.com/tidbcloud/nutshell-skills).

State what you are trying to do and what you already know. The plugin works out
**which of the 59 nutshell skills to invoke, in what order**, fills in the auth
and routing prerequisites people forget, gates anything that writes, and then
executes step by step — loading one `SKILL.md` at a time instead of keeping all
of them in context.

Design rationale and the full architecture: [DESIGN.md](DESIGN.md).

## Prerequisite: access to `tidbcloud/nutshell-skills`

The 59 skills this router indexes live in a **private** PingCAP repository.
Cloning it (`make sync`, below) only works if:

1. your GitHub account is a **member of the `tidbcloud` org**, with read access
   to `tidbcloud/nutshell-skills` — ask whoever administers that org to add you;
2. locally, `gh auth status` shows you logged in as that account (this repo's
   `scripts/sync-source.sh` clones via `gh repo clone`, falling back to
   `git@github.com:tidbcloud/nutshell-skills.git` over SSH if `gh` is absent).

Without both, `make sync` / `make smoke` / `/tidb` fail at the same first step:
resolving the skill source. There is nothing this repo can do about that on its
own — see [`config/settings.json`](config/settings.json) and
[`scripts/lib/paths.mjs`](scripts/lib/paths.mjs) if you'd rather point at a
checkout someone else already made (a shared drive, an internal mirror), via
`NUTSHELL_SKILLS_PATH` or `nutshellPath`.

The daily CI job ([`.github/workflows/catalog-drift.yml`](.github/workflows/catalog-drift.yml))
needs the same access from the *runner's* side: a `NUTSHELL_SKILLS_TOKEN`
repository secret holding a PAT with read access to `tidbcloud/nutshell-skills`.

## Why

Installing all 59 skills costs roughly **199k tokens** of `SKILL.md` (555k with
their bundled `references/` and `knowledge/`), and still leaves you guessing
whether a TiKV latency problem belongs to `tikv-fast-tune` or `tikv-performance`
— or that `o11y-metrics-api` is useless until you have run `o11y-auth` first.

This plugin keeps a **1.8k-token digest** resident and loads the full skill only
once the plan selects it.

## Install

```bash
git clone https://github.com/ayenller/tidb-skill-rounter.git && cd tidb-skill-rounter
make sync      # clone tidbcloud/nutshell-skills into .cache/ - see the prerequisite above
make catalog   # generate catalog/catalog.json + catalog/digest.md
make smoke     # acceptance: catalog + routing + plan verification + trajectory + eval
```

Already have a `nutshell-skills` checkout elsewhere (a shared drive, another
clone)? Point at it instead of letting `make sync` make its own, with either:

```bash
export NUTSHELL_SKILLS_PATH=~/lc/nutshell-skills
```

or `nutshellPath` in `config/settings.json`. The resolver also recovers the
checkout by following a live symlink under `~/.claude/skills/`.

Then register it as a Claude Code plugin — there is no published marketplace
yet, so this repo doubles as its own single-plugin local marketplace
(`.claude-plugin/marketplace.json`):

```bash
claude plugin marketplace add /path/to/tidb-skill-rounter
claude plugin install tidb-all-in-one@tidb-all-in-one -y
```

Start a **new** Claude Code session afterwards — the command list loads at
session start, so `/tidb` will not appear in a session that was already
running when you installed. `claude plugin install` copies the repo into
`~/.claude/plugins/cache/`; it is a snapshot, not a live link, and
`claude plugin update` only re-copies when `.claude-plugin/plugin.json`'s
`version` field changes. While iterating locally, the reliable way to pick up
an edit is:

```bash
claude plugin uninstall tidb-all-in-one && claude plugin install tidb-all-in-one@tidb-all-in-one -y
```

(then start a new session again).

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
| `scripts/retrieve.mjs` | the retrieval seam: arg parsing, dispatch, rendering |
| `scripts/retrievers/*.mjs` | the actual stage-1 scoring; swap by one config line ([contract](scripts/retrievers/CONTRACT.md)) |
| `scripts/lexicon-audit.mjs` | which Chinese wording still reaches the retriever as noise |
| `scripts/export-adapters.mjs` | regenerates the same commands for OpenCode and Codex |
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
node scripts/trajectory.mjs resume s_20260905_150414_bb70
node scripts/trajectory.mjs fork   s_20260905_150414_bb70 --at s4   # try a second hypothesis
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
| coarse-filter fallback | 13.3% | — |

45 cases: 35 real goals, 4 near-miss pairs that differ only by intent or product
line, 4 that **no skill covers**, and 2 that pin a specific tenant/org synonym
regression (below) — because a router that always produces a confident top 3 is
a random skill generator with good manners.

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
  TiKV unsafe-recovery handbook;
- adding a tenant/org case: "which clusters belong to this **org**" could not
  find `platform/devops-api` at all — its catalog text only ever says
  "tenant", and TiDB Cloud treats the two words as one identifier. Fixing that
  exposed a second bug in the same code path: `signal` was computed as
  `fallback ? 'none' : ...`, conflating "the shortlist needed padding because
  fewer than 3 skills scored above zero" with "the top candidate has no real
  evidence" — a query that correctly matches only one or two skills was getting
  told it matched nothing.

One thing the eval also settled: `signal` measures keyword overlap, **not**
correctness. Short Chinese goals route correctly on one concept of overlap or
none at all, so signal is asserted only on the negative cases and must never
gate execution by itself.

## Portability

Only the command layer is Claude-specific, and it is generated:

```bash
make adapters      # regenerate adapters/opencode/ and adapters/codex/
bash adapters/install.sh
```

The catalog, overlay, lexicon, retriever, verifier, trajectory, eval and the
router skill itself are shared verbatim across all three runtimes. If porting
ever needs more than `scripts/export-adapters.mjs`, that claim was false.

## Maintaining the Chinese lexicon

```bash
make lexicon
```

Ranks unmapped Chinese phrases by *harm* — how often they appear in goals that
actually retrieved weakly — rather than by frequency, so grammatical filler
sinks and real gaps float. It sorts findings into three kinds and only one of
them is a lexicon edit:

1. a Chinese word for something a skill's text already says in English → lexicon gap;
2. a word for something a skill **does** but its text never says → a `subject`
   gap in the overlay. This is the common one: "TiKV CPU 指标" scored weak
   against `o11y-metrics-api` because its text says *metrics/prometheus/promql*
   and never names a component. Adding the components it serves took that case
   from weak to strong with zero regressions across the eval suite;
3. a phrase no skill covers → leave it. Scoring zero is the router correctly
   reporting it does not know.

## Status

M0-M4 complete; `make smoke` runs 35 checks and includes the eval.

Implemented: catalog build and validation, overlay, bilingual coarse retrieval,
concept-level signal, family collapse, prerequisite closure, plan verification,
step-level effect narrowing, the security gate, append-only trajectory with
resume / fork / replay / gaps, the `tidb-planner` subagent, four modes
(`/tidb`, `/tidb-plan`, `/tidb-which`, `/tidb-resume`), `/tidb-catalog`, the
routing eval, and a daily CI job that rebuilds the catalog against upstream HEAD
and opens a drift PR.

Also implemented: the retriever seam (proved behaviour-preserving — extracting
BM25 into `scripts/retrievers/bm25.mjs` changed no ranking across the eval
suite), the lexicon audit, TiDB-domain synonym folding (`org`/`tenant` are one
identifier — see `SYNONYMS` in `bm25.mjs`), and the OpenCode/Codex adapters.

Not done: a semantic retriever. It is the only real answer to a goal like
"把备份恢复到新集群", which routes correctly today on the intent prior with **no**
keyword evidence at all. The seam is ready for it — one file implementing
[the contract](scripts/retrievers/CONTRACT.md) plus one config line — but it
needs an embeddings endpoint, which this plugin does not currently depend on.

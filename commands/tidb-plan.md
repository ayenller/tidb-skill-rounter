---
description: Plan only — show which TiDB skills would be used and why, without executing
argument-hint: "<goal>"
---

Goal: $ARGUMENTS

Run the `tidb-aio-router` procedure in **plan-only mode**: intake, retrieval,
planning, and verification — then stop.

Do not execute any step, do not load the planned skills' full content, and do
not call any API. The deliverable is the plan itself:

- the task frame you inferred, with every `unknown` slot called out;
- the verified plan, including auto-inserted prerequisites and the branch points;
- the context cost estimate;
- for each step, one line on what it will establish;
- the candidates you rejected and why (at most three).

This mode exists for two audiences: someone learning the skill catalog who wants
the map before the territory, and a reviewer checking whether an investigation
plan is sound before anyone runs it. Optimise for legibility, not brevity.

End by offering to execute it with `/tidb`.

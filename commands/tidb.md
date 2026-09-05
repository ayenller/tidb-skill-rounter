---
description: Route a TiDB Cloud goal to the right nutshell skills, then execute the plan
argument-hint: "<goal> (e.g. Starter 集群昨天下午开始变慢)"
---

Use the `tidb-aio-router` skill to handle this goal end to end in **guided mode**.

Goal: $ARGUMENTS

Follow the router skill's procedure exactly:

1. Preflight the catalog.
2. Intake — ask at most four routing-relevant questions in a single round, with
   your best guess attached to each. If the goal above is already specific
   enough to pin `product_line`, `target`, and `time_window`, skip straight to
   retrieval and say what you inferred.
3. Retrieve with `scripts/retrieve.mjs` and fine-rank the shortlist yourself.
4. Show the plan, including auto-inserted prerequisites and the context estimate.
5. Wait for confirmation, then execute step by step, loading one SKILL.md at a time.
6. Report the conclusion, the evidence, and the skill path actually walked.

If the goal is empty, ask for it in one line instead of guessing.

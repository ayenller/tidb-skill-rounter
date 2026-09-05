---
description: Minimal mode — answer "which skill should I use?" in seconds, no intake
argument-hint: "<question or goal>"
---

Question: $ARGUMENTS

Skip intake entirely. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/retrieve.mjs" --goal "$ARGUMENTS" --top 8
```

Then answer in under 15 lines:

1. the top 3 skills, each with its catalog path and one line on what it covers;
2. the order to read them in, and why;
3. any prerequisite the retriever auto-inserted, stated as "you will need X first";
4. one line on what would change the answer — usually the product line.

Do not plan, do not verify, do not execute, do not ask questions. If the
retriever reports `fallback: true`, say the keyword match was weak and that a
product line or a symptom keyword would sharpen it.

---
description: Resume, inspect, or fork a previous /tidb routing session
argument-hint: "[session-id | list | fork <id> --at <step>]"
---

Argument: $ARGUMENTS

- empty or `list` — run `node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" list`
  and show the sessions, newest first. If exactly one is open, offer to resume it.
- a session id — run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/trajectory.mjs" resume <id>`, show the
  progress, then continue the `tidb-aio-router` procedure **from the next
  pending step**. Do not re-run completed steps and do not re-plan unless the
  verifier verdict was a failure or the user asks for it.
- `fork <id> --at <step>` — run the same script's `fork` subcommand, then plan
  an alternative continuation from that point. Say explicitly which branch you
  are exploring and how it differs from the original.

Keep appending to the trajectory as you go: `context_injection` on every
SKILL.md you load, `step_done` on every step you finish.

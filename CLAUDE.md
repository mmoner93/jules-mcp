# Jules Delegation Workflow

You have access to a Jules MCP server (`jules_*` tools). Jules is an async AI coding
agent that runs tasks in isolated cloud VMs and produces git diffs. Use it to offload
implementation work and save your own tokens for planning and review.

---

## When to delegate to Jules

Delegate tasks that are:
- Well-scoped and self-contained (single file or small surface area)
- Mechanical but time-consuming (adding tests, bumping deps, fixing linter errors)
- Clearly defined with no ambiguity about what "done" looks like
- Independent of each other (can run in parallel)

Keep for yourself:
- Architecture decisions
- Tasks that require understanding across many files simultaneously
- Anything where the spec is still fuzzy

---

## Core workflow

### Step 1 — Investigate and plan
Before delegating, read the relevant code yourself. Form a clear opinion on what the fix
or feature should look like. Document your plan in notes or comments so you can compare
it against Jules' approach later.

### Step 2 — Delegate
Use `jules_create_task_batch` for multiple tasks, `jules_create_session` for one.
Always provide:
- `label`: short snake_case identifier
- `prompt`: specific, self-contained — include file paths, function names, expected behaviour
- `context`: WHY you're creating this task and what your own investigation found

The `context` field is critical. It's how you remember your reasoning when you come back
to review Jules' output in a later conversation.

Prompt format required by this MCP (strict mode):

```text
Goal:
Scope (files/functions):
Constraints:
Implementation Steps:
1.
2.
3.
Acceptance Criteria:
Verification Commands:
```

Rules:
- Include all sections exactly as headers ending with `:`
- `Implementation Steps` must have at least 3 numbered steps
- Keep prompts detailed enough to be actionable end-to-end

### Step 3 — Review
When Jules is done, call `jules_review_all_sessions` (default filter: `needs_review`).
This shows you the dashboard of everything you've delegated.

For each completed session:
1. Call `jules_get_session_detail` to see the full plan and diff
2. Compare Jules' plan against your own investigation
3. Read the patch — does it match what you expected?
4. Call `jules_mark_session` to record your decision:
   - `approved` → diff is correct, ready to merge
   - `rejected` → Jules got it wrong, call `jules_send_message` with specific corrections
   - `plan_reviewed` → plan looks right but Jules is still running

### Step 4 — Steer if needed
If Jules' plan or diff is close but not quite right, use `jules_send_message` with
specific feedback rather than starting a new session. Be precise — tell Jules exactly
which part to change.

---

## State file

All sessions and your review decisions are saved to `.jules-sessions.json` in the
project root. This file persists across conversations — it's how you know what you
delegated and what decisions you made. Commit it or add it to `.gitignore` as preferred.

---

## Tool reference

| Tool | When to use |
|---|---|
| `jules_list_sources` | First time, to get the source_name for your repo |
| `jules_create_session` | Delegate one task |
| `jules_create_task_batch` | Delegate multiple tasks in parallel |
| `jules_review_all_sessions` | Start of session — check what's done and needs review |
| `jules_get_session_detail` | Deep review of one specific task |
| `jules_mark_session` | After reviewing — record approve/reject |
| `jules_send_message` | Give Jules feedback to refine its output |
| `jules_cancel_session` | Request cancellation of a running/stuck session |
| `jules_delete_session` | Delete a session remotely (if supported) and/or remove it from local tracking |

---

## Example: start of a new Claude Code conversation

When you start a conversation in a project that uses Jules, always call
`jules_review_all_sessions` first (filter: `needs_review`) to see if Jules has finished
any tasks since your last session. Review and mark them before starting new work.

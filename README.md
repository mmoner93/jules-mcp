# jules-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects **Claude Code** to **[Jules](https://jules.google)** — Google's async AI coding agent.

Use it to delegate implementation tasks from Claude Code to Jules, review Jules' proposed plans and diffs, and track every decision across conversations — all without leaving your terminal.

```
Claude Code  ──plans──▶  jules-mcp  ──delegates──▶  Jules (cloud VM)
     ▲                       │                            │
     └──reviews diff─────────┘◀────── git patch ──────────┘
```

---

## Why

Claude Code is great at understanding context and planning. Jules is great at executing well-scoped tasks asynchronously. This MCP lets you use both together:

- **Save Claude Code tokens** — delegate mechanical tasks (tests, refactors, bug fixes, dep bumps) to Jules instead of having Claude Code implement them
- **Run tasks in parallel** — Jules works in the background while Claude Code does other things
- **Track everything** — every delegated task, plan review, and approve/reject decision is saved locally and survives across conversations

---

## Requirements

- Node.js 18+
- A [Jules](https://jules.google) account with at least one GitHub repo connected
- A Jules API key — get one at [jules.google.com/settings#api](https://jules.google.com/settings#api)
- [Claude Code](https://claude.ai/code) installed

---

## Installation

**1. Clone the repo**

```bash
git clone https://github.com/mmoner93/jules-mcp.git
cd jules-mcp
```

**2. Install dependencies**

```bash
npm install
```

**3. Get your Jules API key**

Go to [jules.google.com/settings#api](https://jules.google.com/settings#api) and create a key. You can have up to 3 keys at a time.

**4. Register with Claude Code**

Choose one setup mode:

### Option A: System-wide setup (`~/.claude.json`)

This adds `jules` globally so all projects can use it:

PowerShell (Windows):
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-system-wide.ps1
```

Node (any OS):
```bash
node ./scripts/setup-system-wide.mjs
```

bash (Linux/macOS):
```bash
chmod +x ./scripts/setup-system-wide.sh
./scripts/setup-system-wide.sh
```

The script will:
- Ask for your Jules API key
- Write/update `~/.claude.json`
- Use `~/.jules-sessions.json` as the default state file

### Option B: Per-project setup (`<project>/.mcp.json`)

This adds `jules` only for one project:

PowerShell (Windows):
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-project.ps1
```

Node (any OS):
```bash
node ./scripts/setup-project.mjs
```

bash (Linux/macOS):
```bash
chmod +x ./scripts/setup-project.sh
./scripts/setup-project.sh
```

The script will:
- Ask for your Jules API key
- Ask for your project root path
- Write/update `<project>/.mcp.json`
- Set `JULES_STATE_FILE` to `<project>/.jules-sessions.json`

### Manual config (if you prefer)

For project-local config, add this to `<project>/.mcp.json`:

```json
{
  "mcpServers": {
    "jules": {
      "command": "node",
      "args": ["/absolute/path/to/jules-mcp/index.js"],
      "env": {
        "JULES_API_KEY": "your_api_key_here",
        "JULES_STATE_FILE": "/absolute/path/to/your/project/.jules-sessions.json"
      }
    }
  }
}
```

For global config, add the same object under `mcpServers` in `~/.claude.json`.

> `JULES_STATE_FILE` is where delegated tasks and review decisions are persisted. Point it at your project root if you want state tracked per repo. You can `.gitignore` it or commit it.

**5. Verify it works**

Start Claude Code and ask:

```
List my Jules sources
```

If you see your connected GitHub repos, the MCP is working.

---

## Usage

### Recommended: add CLAUDE.md to your project

Copy `CLAUDE.md` from this repo into your project root. It teaches Claude Code how to use the Jules workflow automatically — when to delegate, how to review, and what to do at the start of each session.

```bash
cp /path/to/jules-mcp/CLAUDE.md /path/to/your/project/CLAUDE.md
```

### The workflow

**Start of every Claude Code session**

Claude Code will automatically call `jules_review_all_sessions` to check if Jules finished anything since your last session. If it doesn't, ask:

```
Check if Jules has finished any tasks
```

**Delegating tasks**

Ask Claude Code to delegate work:

```
Delegate these tasks to Jules:
- Add unit tests for src/auth/login.ts
- Fix the null check bug on line 42 of src/auth/login.ts
- Bump all dev dependencies to latest
```

Claude Code will call `jules_create_task_batch`, write prompts for Jules, and save them to your state file with context about why each task was created.

**Reviewing Jules' output**

When Jules finishes, ask:

```
Review all completed Jules tasks
```

Claude Code will fetch each plan and diff, compare them against its own understanding of the codebase, and propose approve/reject decisions for you to confirm.

**Approving or rejecting**

```
Approve the login fix, reject the dependency bump — Jules missed the peer dep constraint
```

Decisions are saved to `.jules-sessions.json`. If you reject a task, Claude Code will send Jules specific feedback via `jules_send_message` so it can try again.

**Merging**

Once you approve a session, Jules will have opened a PR on GitHub. Review and merge it there as normal.

---

## Tools reference

| Tool | What it does |
|---|---|
| `jules_list_sources` | List GitHub repos connected to your Jules account |
| `jules_create_session` | Delegate a single task to Jules |
| `jules_create_task_batch` | Delegate multiple tasks in parallel |
| `jules_review_all_sessions` | Dashboard of all delegated tasks and their status |
| `jules_get_session_detail` | Full plan + complete git diff for one session |
| `jules_mark_session` | Record approve / reject / merged decision |
| `jules_send_message` | Send Jules feedback to refine its plan or diff |

---

## Session state file

All sessions are tracked in `.jules-sessions.json`. Example:

```json
{
  "sessions": {
    "abc123": {
      "label": "fix-login-null-check",
      "prompt": "Fix null pointer in src/auth/login.ts line 42 when user.email is undefined...",
      "context": "User reported a crash on empty email input. Traced to login.ts:42.",
      "created_at": "2026-04-25T10:00:00.000Z",
      "review_status": "approved",
      "notes": "Jules' diff matches my analysis. Handles undefined and empty string.",
      "reviewed_at": "2026-04-25T10:45:00.000Z"
    }
  }
}
```

`review_status` values:

| Value | Meaning |
|---|---|
| `pending` | Jules is still working, or task not yet reviewed |
| `plan_reviewed` | Plan looks good, Jules still running |
| `approved` | Diff is correct, ready to merge on GitHub |
| `rejected` | Jules got it wrong — feedback sent |
| `merged` | PR merged, done |

---

## Tips

**Write a good AGENTS.md**

Jules reads `AGENTS.md` from your repo root before starting any task. Add yours:

```markdown
# AGENTS.md

## Tech stack
- Node.js 20, TypeScript, Express
- Jest for tests, Prettier + ESLint for formatting

## Standards
- Functional components only (no classes)
- All new logic needs unit tests
- Use existing patterns in /src/utils for API calls

## Out of scope for Jules
- Database migrations
- Changes to .env or CI config
```

This significantly improves Jules' output quality.

**Keep tasks self-contained**

Jules works best when a task can be understood without reading 20 files. Good: *"Add input validation to the createUser function in src/users/service.ts"*. Bad: *"Improve the auth system"*.

**Use the `context` field**

When Claude Code creates a session, it stores your investigation notes in the `context` field. This is what lets Claude Code make a meaningful review decision later — it compares Jules' approach against what you already found.

**Batch independent tasks**

`jules_create_task_batch` runs tasks concurrently. If you have 5 independent bug fixes, delegate them all at once and review the diffs together.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JULES_API_KEY` | Yes | — | Jules API key from jules.google.com/settings#api |
| `JULES_STATE_FILE` | No | `.jules-sessions.json` | Path to the local session state file |

---

## Limitations

- **Jules is in alpha** — the API may change. Pin to a specific version of this MCP if stability matters.
- **PR merging is manual** — Jules opens a PR on GitHub; you merge it yourself after approving.
- **No cross-task dependencies** — tasks in a batch must be independent. Jules doesn't coordinate between sessions.
- **GitHub only** — Jules currently only supports GitHub repos.

---

## License

MIT

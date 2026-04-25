#!/usr/bin/env node
/**
 * Jules MCP Server for Claude Code — v2
 * - Tracks every session Claude Code starts in .jules-sessions.json
 * - Lets Claude review all open tasks, their plans, and diffs in one call
 * - Marks tasks as reviewed / approved / rejected locally
 *
 * Install:  npm install @modelcontextprotocol/sdk zod
 * Run:      JULES_API_KEY=your_key node index.js
 *
 * Register in .claude/settings.json:
 * {
 *   "mcpServers": {
 *     "jules": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/jules-mcp/index.js"],
 *       "env": {
 *         "JULES_API_KEY": "your_key",
 *         "JULES_STATE_FILE": "/path/to/project/.jules-sessions.json"
 *       }
 *     }
 *   }
 * }
 *
 * Get your API key: https://jules.google.com/settings#api
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://jules.googleapis.com/v1alpha";
const API_KEY = process.env.JULES_API_KEY ?? "";
const STATE_FILE = process.env.JULES_STATE_FILE ?? ".jules-sessions.json";

if (!API_KEY) {
  process.stderr.write(
    "[jules-mcp] ERROR: JULES_API_KEY is not set.\n" +
    "Get your key at https://jules.google.com/settings#api\n"
  );
  process.exit(1);
}

// ─── Local session state ──────────────────────────────────────────────────────
// Persists across Claude Code conversations so Claude always knows what it started.
// Saved to JULES_STATE_FILE (default: .jules-sessions.json in working dir).

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function recordSession(session_id, meta) {
  const state = loadState();
  state.sessions[session_id] = {
    ...meta,
    session_id,
    created_at: new Date().toISOString(),
    review_status: "pending", // pending | plan_reviewed | approved | rejected | merged
    notes: "",
  };
  saveState(state);
}

function updateSession(session_id, patch) {
  const state = loadState();
  if (!state.sessions[session_id]) state.sessions[session_id] = { session_id };
  Object.assign(state.sessions[session_id], patch);
  saveState(state);
}

// ─── Repo auto-detection ──────────────────────────────────────────────────────

async function detectSourceName() {
  let remoteUrl;
  try {
    remoteUrl = execSync("git remote get-url origin", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().replace(/\.git$/, "");
  } catch {
    throw new Error("Could not read git remote origin. Are you in a git repo?");
  }

  const match = remoteUrl.match(/github\.com[:/](.+)$/);
  if (!match) throw new Error(`Remote "${remoteUrl}" is not a GitHub URL.`);
  const ownerRepo = match[1];

  const data = await julesGet("sources");
  const sources = data.sources ?? [];
  const found = sources.find((s) => s.name === `sources/github/${ownerRepo}`);
  if (!found) {
    const connected = sources.map((s) => s.name.replace("sources/github/", "")).join(", ");
    throw new Error(`"${ownerRepo}" is not connected to Jules. Connected repos: ${connected}`);
  }
  return found.name;
}

// ─── Jules REST helpers ───────────────────────────────────────────────────────

async function julesGet(urlPath) {
  const res = await fetch(`${BASE_URL}/${urlPath}`, {
    headers: { "X-Goog-Api-Key": API_KEY, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Jules ${res.status}: ${await res.text()}`);
  return res.json();
}

async function julesPost(urlPath, body) {
  const res = await fetch(`${BASE_URL}/${urlPath}`, {
    method: "POST",
    headers: { "X-Goog-Api-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jules ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : {};
}

function extractId(data) {
  return data?.name?.split("/").pop() ?? data?.id ?? "unknown";
}

/** Fetch live Jules status for a session and return a clean summary */
async function fetchLiveSummary(session_id) {
  try {
    const data = await julesGet(`sessions/${session_id}/activities`);
    const activities = data.activities ?? [];

    const plan_steps = activities
      .filter((a) => a.planGenerated)
      .flatMap((a) =>
        (a.planGenerated?.plan?.steps ?? []).map((s, i) => `${i + 1}. ${s.title ?? s.id}`)
      );

    const latest_progress = activities
      .filter((a) => a.progressUpdated)
      .map((a) => a.progressUpdated?.description ?? a.progressUpdated?.title ?? "")
      .filter(Boolean)
      .at(-1) ?? null;

    const patches = activities
      .filter((a) => a.artifacts?.length)
      .flatMap((a) =>
        a.artifacts.map((art) => ({
          commit_message: art.changeSet?.gitPatch?.suggestedCommitMessage ?? "",
          base_commit: art.changeSet?.gitPatch?.baseCommitId ?? "",
          patch: (art.changeSet?.gitPatch?.unidiffPatch ?? "").slice(0, 4000),
          patch_truncated: (art.changeSet?.gitPatch?.unidiffPatch ?? "").length > 4000,
        }))
      );

    const completed = activities.some((a) => "sessionCompleted" in a);

    return { session_id, completed, has_plan: plan_steps.length > 0, plan_steps, latest_progress, patches };
  } catch (e) {
    return { session_id, error: e.message };
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({ name: "jules-mcp", version: "2.0.0" });

// ── 1. jules_list_sources ────────────────────────────────────────────────────

server.tool(
  "jules_list_sources",
  "List GitHub repositories connected to Jules. Use returned source_name values when creating sessions.",
  {},
  async () => {
    const data = await julesGet("sources");
    const sources = (data.sources ?? []).map((s) => ({
      source_name: s.name,
      repo: s.name.replace(/^sources\/github\//, ""),
    }));
    return { content: [{ type: "text", text: JSON.stringify({ sources }, null, 2) }] };
  }
);

// ── 2. jules_create_session ──────────────────────────────────────────────────

server.tool(
  "jules_create_session",
  "Delegate a single coding task to Jules and save it locally for later review. " +
  "Jules runs asynchronously — call jules_review_all_sessions later to check progress.",
  {
    source_name: z.string().optional().describe("Repo resource name from jules_list_sources. Auto-detected from git remote if omitted."),
    prompt: z.string().describe(
      "Self-contained task for Jules. Include: what to do, which files/functions, expected behaviour, constraints."
    ),
    label: z.string().describe("Short identifier for this task, e.g. 'fix-login-null-check'."),
    context: z.string().optional().describe(
      "Why this task was created — what investigation or reasoning led to it. " +
      "Stored locally so this context survives across Claude Code conversations."
    ),
  },
  async ({ source_name, prompt, label, context }) => {
    const resolvedSource = source_name ?? await detectSourceName();
    const data = await julesPost("sessions", { source: { name: resolvedSource }, prompt });
    const id = extractId(data);

    recordSession(id, { label, prompt, source_name: resolvedSource, context: context ?? "", resource_name: data.name ?? "" });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          session_id: id,
          label,
          status: "Jules is working asynchronously",
          next: "Call jules_review_all_sessions later to review the plan and diff.",
        }, null, 2),
      }],
    };
  }
);

// ── 3. jules_create_task_batch ───────────────────────────────────────────────

server.tool(
  "jules_create_task_batch",
  "Delegate multiple independent tasks to Jules concurrently. All sessions are tracked locally. " +
  "This is the main token-saving pattern: Claude Code plans, Jules executes in parallel.",
  {
    source_name: z.string().optional().describe("Repo resource name from jules_list_sources. Auto-detected from git remote if omitted."),
    tasks: z.array(
      z.object({
        label: z.string().describe("Short identifier, e.g. 'add-unit-tests-auth'."),
        prompt: z.string().describe("Self-contained task description."),
        context: z.string().optional().describe("Why this task was created."),
      })
    ).describe("Tasks to run concurrently. Must be independent of each other."),
  },
  async ({ source_name, tasks }) => {
    const resolvedSource = source_name ?? await detectSourceName();
    const results = await Promise.allSettled(
      tasks.map(({ prompt }) => julesPost("sessions", { source: { name: resolvedSource }, prompt }))
    );

    const sessions = results.map((result, i) => {
      const task = tasks[i];
      if (result.status === "fulfilled") {
        const id = extractId(result.value);
        recordSession(id, {
          label: task.label,
          prompt: task.prompt,
          source_name: resolvedSource,
          context: task.context ?? "",
          resource_name: result.value.name ?? "",
        });
        return { label: task.label, session_id: id, status: "created" };
      }
      return { label: task.label, session_id: null, status: "error", error: result.reason?.message };
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          created: sessions.filter((s) => s.status === "created").length,
          failed: sessions.filter((s) => s.status === "error").length,
          sessions,
          next: "Call jules_review_all_sessions to review plans and diffs when ready.",
        }, null, 2),
      }],
    };
  }
);

// ── 4. jules_review_all_sessions  ← THE MAIN WORKFLOW TOOL ───────────────────
// Claude Code calls this to see everything it delegated, their current status,
// plans, diffs — in one shot. This is how Claude knows what it started and what changed.

server.tool(
  "jules_review_all_sessions",
  "Review ALL tasks Claude Code has delegated to Jules. " +
  "Returns a dashboard with local metadata (label, why it was created, review decision) " +
  "merged with live Jules data (plan steps, progress, git diff). " +
  "This is how Claude Code tracks what it started and reviews proposed code changes.",
  {
    filter: z.enum(["all", "pending", "completed", "needs_review"]).default("needs_review").describe(
      "all = everything | " +
      "pending = Jules still working | " +
      "completed = Jules finished | " +
      "needs_review = Jules done but Claude hasn't reviewed yet (DEFAULT)"
    ),
  },
  async ({ filter }) => {
    const state = loadState();
    const entries = Object.values(state.sessions);

    if (entries.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No sessions tracked yet. Use jules_create_session or jules_create_task_batch to delegate tasks.",
        }],
      };
    }

    // Fetch live Jules status for all sessions in parallel
    const summaries = await Promise.all(entries.map((s) => fetchLiveSummary(s.session_id)));

    // Merge local metadata with live Jules data
    const merged = entries.map((local, i) => ({
      label: local.label,
      session_id: local.session_id,
      created_at: local.created_at,
      review_status: local.review_status,   // Claude Code's own review decision
      notes: local.notes,                   // Claude Code's own notes
      context: local.context,               // why this task was created
      prompt_preview: (local.prompt ?? "").slice(0, 120),
      ...summaries[i],
    }));

    // Apply filter
    const filtered = merged.filter((s) => {
      if (filter === "all") return true;
      if (filter === "pending") return !s.completed && !s.error;
      if (filter === "completed") return s.completed;
      if (filter === "needs_review") return s.completed && s.review_status === "pending";
      return true;
    });

    // Quick dashboard summary
    const dashboard = {
      total_sessions: merged.length,
      jules_still_working: merged.filter((s) => !s.completed && !s.error).length,
      jules_finished: merged.filter((s) => s.completed).length,
      needs_your_review: merged.filter((s) => s.completed && s.review_status === "pending").length,
      approved: merged.filter((s) => s.review_status === "approved").length,
      rejected: merged.filter((s) => s.review_status === "rejected").length,
      merged: merged.filter((s) => s.review_status === "merged").length,
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ dashboard, sessions: filtered }, null, 2),
      }],
    };
  }
);

// ── 5. jules_get_session_detail ───────────────────────────────────────────────

server.tool(
  "jules_get_session_detail",
  "Deep-dive on one Jules session: full plan, complete git diff, all progress updates, " +
  "and the context/notes stored when the task was created. " +
  "Use this before making an approve/reject decision.",
  {
    session_id: z.string().describe("Session ID to inspect."),
  },
  async ({ session_id }) => {
    const state = loadState();
    const local = state.sessions[session_id] ?? {};

    const data = await julesGet(`sessions/${session_id}/activities`);
    const activities = data.activities ?? [];

    const plan_steps = activities
      .filter((a) => a.planGenerated)
      .flatMap((a) =>
        (a.planGenerated?.plan?.steps ?? []).map((s, i) => `${i + 1}. ${s.title ?? s.id}`)
      );

    const progress = activities
      .filter((a) => a.progressUpdated)
      .map((a) => ({ time: a.createTime, message: a.progressUpdated?.description ?? a.progressUpdated?.title }));

    const patches = activities
      .filter((a) => a.artifacts?.length)
      .flatMap((a) =>
        a.artifacts.map((art) => ({
          commit_message: art.changeSet?.gitPatch?.suggestedCommitMessage,
          base_commit: art.changeSet?.gitPatch?.baseCommitId,
          full_patch: art.changeSet?.gitPatch?.unidiffPatch, // full, not truncated
        }))
      );

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          // Local context — why Claude Code created this task
          label: local.label ?? session_id,
          context: local.context ?? "(none stored)",
          original_prompt: local.prompt ?? "(not tracked)",
          created_at: local.created_at,
          review_status: local.review_status ?? "unknown",
          notes: local.notes ?? "",

          // Live Jules output
          completed: activities.some((a) => "sessionCompleted" in a),
          plan_steps,
          progress,
          patches,
        }, null, 2),
      }],
    };
  }
);

// ── 6. jules_mark_session ────────────────────────────────────────────────────
// Claude Code records its review decision — persists across conversations.

server.tool(
  "jules_mark_session",
  "Record Claude Code's review decision for a session. " +
  "This persists across conversations so Claude always knows the status of each task. " +
  "Always call this after reviewing a plan or diff.",
  {
    session_id: z.string().describe("Session ID to update."),
    review_status: z.enum(["plan_reviewed", "approved", "rejected", "merged"]).describe(
      "plan_reviewed = plan looks good, Jules still running | " +
      "approved = diff is correct, ready to merge | " +
      "rejected = Jules approach is wrong, needs rework | " +
      "merged = done"
    ),
    notes: z.string().optional().describe(
      "Claude Code's notes — why approved/rejected, what needs changing, open questions."
    ),
  },
  async ({ session_id, review_status, notes }) => {
    updateSession(session_id, { review_status, notes: notes ?? "", reviewed_at: new Date().toISOString() });
    const state = loadState();
    const label = state.sessions[session_id]?.label ?? session_id;
    return {
      content: [{
        type: "text",
        text: `"${label}" (${session_id}) marked as "${review_status}". Saved to ${path.resolve(STATE_FILE)}.`,
      }],
    };
  }
);

// ── 7. jules_send_message ────────────────────────────────────────────────────

server.tool(
  "jules_send_message",
  "Send a follow-up instruction to Jules — to refine its plan or fix its diff. " +
  "Resets the session review_status to pending.",
  {
    session_id: z.string().describe("Session ID to message."),
    message: z.string().describe("Specific instruction or feedback for Jules."),
  },
  async ({ session_id, message }) => {
    await julesPost(`sessions/${session_id}:sendMessage`, { prompt: message });
    updateSession(session_id, { review_status: "pending", last_message_sent: message });
    return {
      content: [{
        type: "text",
        text: `Message sent to session ${session_id}. Status reset to "pending". ` +
              `Call jules_review_all_sessions to check Jules' response.`,
      }],
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[jules-mcp] Server ready. Tracking sessions in: ${path.resolve(STATE_FILE)}\n`);

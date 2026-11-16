# mcp/ — the MCP server

Standalone, over stdio; `scripts/bundle.mjs` (esbuild) bundles mcp + core into `plugins/quarterdeck-goals/server/*.mjs` as part of `npm run build`. After a change, rebuild and restart the server and the standing session (root `CLAUDE.md`, Commands).

```
src/
  index.ts        — MCP entry point; registers all tools and dispatches calls
  schema.ts       — Zod schemas for every tool's input parameters
  db.ts           — Binds @quarterdeck/core queries to one connection
  session.ts      — In-memory open-plan ID
  context.ts      — Builds context view objects
  tools/          — One file per MCP tool handler
  tool-filter.ts  — Which tools are listed (plan tools hidden unless QUARTERDECK_TOOLS=all)
  history.ts      — record(): the events log
  update-check.ts — update notice
  runner-session.ts — the standing session (see .claude/rules/standing-session.md)
  doctor.ts       — `npm run doctor`
scripts/bundle.mjs
```

## Data flow for every tool call

1. `src/index.ts` routes by tool name → calls the handler in `tools/`
2. Handler parses args with the Zod schema from `schema.ts`
3. Reads/writes SQLite via `db.ts` helpers
4. Checks/updates the in-memory open plan via `session.ts`
5. Returns a context view built by `context.ts`

**Every mutating MCP tool returns a context view** (result of `buildContext`). Clients never need a follow-up read after a write.

## Adding a new MCP tool

1. Add a Zod schema to `src/schema.ts`
2. Create `src/tools/<tool_name>.ts` with an exported async handler function
3. Import both in `src/index.ts` and add an entry to the `TOOLS` array
4. If it mutates anything, call `record()` (below). If only the person or the plugin may call it, add it to the guard's person-only lists.

**Change history**: every mutating MCP tool calls `record()` (`src/history.ts`) to write an `events` row with `actor: 'agent'`, `via: 'mcp'` and, for edits/status changes, old and new values. The web app writes `actor: 'human'` rows via `recordEvent()`. Both show in the activity feed and in the `get_history` tool.

## Sessions

**Session state is in-memory only** (`src/session.ts`). If the MCP server restarts, the client must call `open_plan` again to re-register the open plan. One MCP server serves the whole Claude Code session, subagents included, so a call with `run_scope` (added to every tool's schema; the guard plugin sets it on a goal run's calls) runs in a scope of its own, holding that run's plan and run, and never touches the process-wide open plan.

**`next_task`** walks the open plan in tree order and returns `continue` (active leaf), `start` (pending leaf with dependencies met), `complete` (all children resolved) or `none` with blockers.

**Plan tools are hidden** (`src/tool-filter.ts`): `ListTools` leaves out `create_plan`, `provision_tasks`, `next_task` and the other plan tools unless `QUARTERDECK_TOOLS=all`. They still answer calls. `update_task` and `set_status` stay listed for goal items.

## Update notice (`src/update-check.ts`)

The server reads the `release` branch's plugin.json from GitHub (at most every 6 hours, in the background, never from a checkout, off with `QUARTERDECK_UPDATE_CHECK=0`) and `goals_overview` carries `update: { installed, latest }` when it is newer, folded into the etag. The pane shows it with "Ask Claude to install it" (`updatePrompt` in `hooks/model.ts`, sent with `sendToChat`). When Claude Code has already installed a newer version on disk (auto-update, or an update from another session) than the server runs, `update` has `ready: true` (`versionOnDisk` reads `installed_plugins.json` in `CLAUDE_CONFIG_DIR` or `~/.claude`) and the pane offers **Reload now** instead, which runs `/reload-plugins` with `$.command.run` (built-ins are in `$.command.list()`; the run waits until the session is idle), else a toast says to type it; the `outdated` notice has the same button. Never reload without the person's press: a goal run's agent may be working.

## Tests

Tests live in `src/tests/`. `vitest.config.ts` sets `QUARTERDECK_DB=:memory:`. Each test gets a clean slate via `beforeEach` in `src/tests/setup.ts`. Call tool handlers directly as async functions — no MCP transport needed.

Live tests are `src/tests/live/*.live.ts` (`vitest.live.config.ts`): they start the bundle (`plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs`) over stdio with a database file and home folder of their own under the temp folder (`server.ts`), so they cover the bundle, the wire, migrations on a real file and watch commands that really run. `npm test` leaves them out; `npm run test:live` builds the bundle first. Watch commands in them are `node print.cjs`, never `cat`, so they run on Windows; a flaky timing gets a longer wait in `server.ts` (15 ms after each call), never a looser assertion.

## Setup

**Doctor**: `npm run doctor` from the repo root (rebuilds core/mcp, then runs `src/doctor.ts`). Add a check there when you add a new piece of setup.

**Claude Code hooks**: goals need none. `scripts/install-hooks.mjs` runs on `npm install`: it removes hooks earlier versions installed in `~/.claude/settings.json` (the plan reminders, the decompose hook and the old goal-guard hook). Skip with `QUARTERDECK_SKIP_HOOKS=1`.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Quarterdeck runs **persistent goals** for AI agents — standing objectives like "keep my inbox under control" that never finish. A goal's state (instructions, open work items, memory, human decisions, run history) lives in SQLite outside any agent; the quarterdeck-goals Claude Code plugin starts each due run in a background subagent, each run reads a one-call brief (`get_goal_brief`) and ends with a summary (`end_run`), and a human approves proposed actions from the Goals pane (or the goal page in the web app). The main use case is goals; **plans** (finite task trees with verification gates) are the underlying building block and still work on their own for long multi-session projects.

Parts: an **MCP server** (`mcp/`, the tools agents and the plugins call; bundled into the quarterdeck-goals plugin, which starts it), two **Claude Code plugins** (`plugins/quarterdeck-goals` runs goals and shows the Goals pane; `plugins/quarterdeck-guard` keeps each run within its goal), and a **Next.js web app** (`web/`, optional: goal pages and webhooks). Shared schema and logic live in `core/`. Design spec: `specs/persistent-goals.md` (phases 1, 2 and 2.5 built).

## Repository Structure

```
Quarterdeck/
  package.json        — monorepo root (npm workspaces: ["core", "mcp", "web"])
  core/               — @quarterdeck/core: the one schema, migrations, shared queries and the goal engine
  mcp/                — MCP server over stdio; bundled into plugins/quarterdeck-goals/server/
  web/                — Next.js web app, optional: goal pages and webhooks (shares the same tasks.db)
  plugins/quarterdeck-goals/ — goal runner (subagents), Goals pane, alerts, /goal* commands, tools for Claude, the MCP server (.mcp.json → server/, gitignored on main)
  plugins/quarterdeck-guard/ — what a goal run may do (run tagging, autonomy guard, reports out of the chat)
  .claude-plugin/marketplace.json — makes the repo a plugin marketplace ("quarterdeck")
  scripts/release.mjs — `npm run release -- <version> [--push]`
  specs/
```

Both `mcp/` and `web/` connect to the same `~/.quarterdeck/tasks.db` (SQLite WAL mode for concurrent access) through Node's built-in `node:sqlite` (Node 22.13+; no native build step, which is what lets the server ship inside the plugin). Import `Database` from `@quarterdeck/core`, never a SQLite package. Override the path with `QUARTERDECK_DB` env var.

## Where the details live

Each folder's own `CLAUDE.md` loads when you work there, and `.claude/rules/*.md` load when you read a file they cover:

- `core/CLAUDE.md` — schema and migrations, task IDs, verification gates, schedules, health checks
- `mcp/CLAUDE.md` — server data flow, adding a tool, history, sessions and `run_scope`, tool filter, update notice, doctor
- `web/CLAUDE.md` — web architecture, request guard, real-time updates
- `plugins/CLAUDE.md` — plugin engine rules, hooks bundling limits, pane conventions
- `.claude/rules/goals-engine.md` — runs, autonomy, items and questions, models, one-off goals, discuss and change, to-do lists, usage limit
- `.claude/rules/guard.md` — the guard, untrusted content, Quarterdeck's own data
- `.claude/rules/watches.md` — watches, tool watches, status checks, status tones
- `.claude/rules/standing-session.md` — the standing session (runner) on Windows and Linux

Rules that hold everywhere, whatever file you're in:

- **"allow" only means Quarterdeck doesn't object.** Claude Code's own permission rules decide every call the guard doesn't refuse, `auto` and approved ones included. Docs and UI copy must never say `auto` lets a call through.
- **Never hard-code one tool prefix** (see below).
- **Bump `SCHEMA_VERSION`** with every schema change (`core/src/migrate.ts`).
- **A new mutating MCP tool must call `record()`** (`mcp/src/history.ts`).
- **Never reload plugins without the person's press**: a goal run's agent may be working.

## Distribution and updates

People install `claude plugin marketplace add shannonbay/Quarterdeck#release` + `claude plugin install quarterdeck-goals@quarterdeck` (quarterdeck-guard comes as a dependency). The goals plugin's `.mcp.json` starts `${CLAUDE_PLUGIN_ROOT}/server/quarterdeck-mcp.mjs`, so the server updates with the plugin (Claude Code's plugin auto-update, off by default for our marketplace; `/reload-plugins` applies it). The `release` branch holds only what installs, built by `scripts/release.mjs`; main never commits `plugins/*/server/`. Before it releases, the script runs every test: `npm test`, the live tests (`npm run test:live --prefix mcp`, about 30 s) and `claude plugin test` for both plugins (`--skip-tests` skips them all). It also bundles each plugin's hooks into one file (limits in `plugins/CLAUDE.md`). Claude Code sees a new version only when plugin.json's `version` changes, which the release script does for both plugins.

**Renamed from Conductor** (Nov 2026). Old names still work on purpose: `CONDUCTOR_*` env vars (read through `envVar()` in `core/src/index.ts`), `~/.conductor/tasks.db` while `~/.quarterdeck` has none (`defaultDbPath`), the `x-conductor-secret` webhook header, and stored goal tool maps get `mcp__conductor__` rewritten by a migration. The doctor's `checkRenameLeftovers` and `install-hooks.mjs` match old names to clean up. Don't "fix" these. The plugin is `quarterdeck-goals`, not `quarterdeck`, because plugin tools are named `mcp__<plugin>__*` and would clash with the MCP server's `mcp__quarterdeck__*`.

**Two names for the server's tools**: the plugin-provided server's tools are `mcp__plugin_quarterdeck-goals_quarterdeck__<tool>` (Claude Code's naming for a plugin's server); an older hand-added server's are `mcp__quarterdeck__<tool>`. Everything accepts both: `canonicalToolName` in `core/src/guard.ts` (tool maps), `hooks/names.ts` + `call()` in `hooks/api.ts` (tries both, caches the one that answers), and `SERVER_PREFIXES`/`serverTool` in the guard plugin. Never hard-code one prefix.

## Commands

**`core/` must be built before `mcp/` or `web/` run or typecheck.** Their `prebuild`, `predev` and `pretypecheck` scripts do it automatically (`npm run build --prefix ../core`). Tests don't need it: both `vitest.config.ts` files alias `@quarterdeck/core` to `core/src`.

**After changing `core/` or `mcp/`**, run `npm run build --prefix mcp` (tsc, then the bundle into the plugin), then **restart the server**: `/mcp` → the plugin's `quarterdeck` server → Reconnect, or restart Claude Code. `/reload-plugins` alone is not enough here: with the plugin read from the folder and its version unchanged, it re-reads the hooks but leaves the running server process (seen Nov 2026: `edit_todo` existed while the server's `todo_set` still had the old schema). To check, compare the server process's start time with `plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs`'s. **Restart the standing session too** (`MSYS_NO_PATHCONV=1 schtasks /run /tn "Quarterdeck goals runner"` from Git Bash or a `!` command, which otherwise turns `/run` into a Windows path; plain `schtasks /run ...` in PowerShell): it has its own server, usually holds the scheduler lease, and so claims runs with the old code until its 5-minute `ensure` notices the new build (seen Nov 2026: a Run now after a scheduler fix still went through the old code). `quarterdeck runner status` and `state.json`'s `build` show which build it's on.

```bash
# Root
npm install                          # Install all workspace dependencies
npm run build                        # Build core, mcp (+ plugin server bundle) and web
npm run release -- 0.12.0 [--push]   # Release (see Distribution and updates)
npm run doctor                       # Setup check (rebuilds core/mcp, then runs mcp/src/doctor.ts)

# core/
npm run build       # Compile to dist/ (what mcp/ and web/ import at runtime)
npm test            # Schema, migration and revision-trigger tests

# mcp/
npm run build       # Compile TypeScript to dist/, then bundle into plugins/quarterdeck-goals/server/
npm run bundle      # Only the bundle
npm run dev         # Run directly with tsx (no compile step)
npm run typecheck   # Type-check without emitting
npm run start       # Run compiled output from dist/
npm test            # Run all tests (vitest)
npm run test:watch  # Watch mode
npm run test:live   # Live tests against the bundled server over stdio (CI runs them)

# web/
npm run dev         # Custom HTTP + WebSocket server with Next.js (tsx server.ts, port 3000)
npm run build       # Production build
npm run typecheck   # Type-check without emitting
npm test            # Run all tests (vitest)

# plugins
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```

To run a single test file: `npm test -- src/tests/tools/create_plan.test.ts` (mcp) or `npm test -- __tests__/api/goals.test.ts` (web).

## Working in This Repo

**Goals are the product; plans are plumbing.** Don't track your own work here with Quarterdeck plans (`create_plan`, `provision_tasks`, ...): use plan mode and Claude Code's own task list, as anywhere else. Plans stay as the store under goal items and the person's to-do lists, so keep their code and tests working, but new features go to goals. When the person defers an idea, offer to add it to their to-do list (`add_todo`); the roadmap is the "Goals roadmap" list.

**Claude is a user too.** When a Quarterdeck tool makes a simple task cost Claude more than it should (a read that returns far more than asked for, a missing filter or input, several calls where one would do, an answer that has to be parsed around), say so to the person and offer it as a to-do. Example (Nov 2026): reading one to-do returned every list; `todos` now takes `item` and `list`.

**Keep these instruction files in step.** Put a new detail in the file for the folder or topic it belongs to, not here; this file is for what every session needs.

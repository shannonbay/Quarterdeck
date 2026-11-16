# core/ — @quarterdeck/core

The one schema, migrations, shared plan/task queries and the goal engine. `mcp/` and `web/` import it; build it (`npm run build`) before they run or typecheck. Goal behaviour is in `.claude/rules/goals-engine.md`, the guard in `.claude/rules/guard.md`, watches and status checks in `.claude/rules/watches.md`.

```
src/migrate.ts    — runMigrations(): every table, column and trigger lives here; SCHEMA_VERSION
src/sqlite.ts     — Database: node:sqlite with the better-sqlite3 calls we use (transaction, pragma)
src/queries.ts    — db-first query functions used by both mcp/ and web/
src/types.ts      — PlanRow, Task, NewPlan, NewTask, TreeStats
src/index.ts      — openDatabase() / defaultDbPath()
```

## One schema

`mcp/src/db.ts` and `web/lib/db.ts` are thin wrappers that bind `@quarterdeck/core` queries to their own connection. To add a field to plans or tasks, change `src/migrate.ts` (CREATE TABLE + ALTER entry) and `src/types.ts` only. Put a query in `src/queries.ts` if both sides need it; web-only queries stay in `web/lib/db.ts`.

**Migrations** (`src/migrate.ts`, re-exported by `web/lib/migrate.ts`): the only place the schema is defined; both processes run it on open. Adding a column uses try/catch around `ALTER TABLE` (SQLite lacks `IF NOT EXISTS` for ALTER). New columns added to a CREATE TABLE must also get an ALTER TABLE entry for existing databases, plus an UPDATE to backfill any NOT NULL semantics. **Bump `SCHEMA_VERSION`** with every schema change: it is stored as `PRAGMA user_version`, and a session running older code (sessions update separately) then sees `schemaOutdated`, claims no runs in `schedulerPass`, and its pane asks for `/reload-plugins` (`goals_overview` `outdated`).

**Revision triggers**: SQLite triggers bump `plans.revision` on every task insert/update/delete and plan update, from any process. The web app polls it for live updates, so don't let routine bookkeeping bump it (see the watches rule).

## Plans and tasks

**Task IDs are tree addresses**, not random IDs. A task's ID encodes its position: `"1"` is the root, `"1.2"` is the second child of root, `"1.2.3"` is the third child of `"1.2"`. `nextChildId()` computes the next available child ID by counting direct children. **`getChildren()` uses a LIKE query** on the ID prefix, then filters to the exact depth. IDs are structural and permanent — renaming/moving tasks is not supported.

**`working_dir` is required on every plan** and is never null. MCP's `create_plan` defaults it to `process.cwd()` (the directory Claude Code was launched from). A goal run works in its goal's `working_dir`.

**`state` updates are shallow-merge patches.** `update_task` with `state_patch` merges at the top level.

**`set_status` to `active` is blocked** if `depends_on` lists any sibling not yet `completed`. With `QUARTERDECK_REQUIRE_DECOMPOSE=1` in the MCP server's env (opt-in), it is also blocked for a task with no children unless its `state.atomic` is `true`; this lives in the server, not a hook, because only the server knows which plan is open. With `QUARTERDECK_STRICT_COMPLETE=1` (opt-in), `set_status` to `completed` throws while any child is not completed/abandoned (otherwise it's a warning in the response).

## Verification gates (`src/gates.ts`)

A task can carry `acceptance_criteria`, a `verify_command` and `requires_approval`. Completion runs them through `checkCompletion()` (MCP `set_status`):
- Agents must pass `evidence` (one entry per criterion), the command must exit 0 (run in the plan's `working_dir`, default timeout 300s, last 4 KB of output kept), and approval tasks then wait with `review_requested_at` set (status stays `active`).
- A human approving counts as the approval (`decideItem`). Agents can't override a failed check.
- Agents can only change gate fields while a task is pending (except turning approval on).
- Every check result is a `verifications` row (the evidence).

## Schedules (`src/schedule.ts`)

One per goal, `interval` (+ active hours) or `cron` (5-field, local time, own parser — no dependency); any run that starts (Run now, webhook, watch, health) restarts an interval from its start, while cron keeps its slots (`schedulerPass`); webhooks store only a sha256 of the secret (`/api/goals/:id/trigger`, Bearer or `x-quarterdeck-secret`; repeats coalesce into the open run).

## Health (`src/health.ts`)

`health_command` exits 0 while the goal is met; the last number printed is the trend value. The scheduler runs due checks each tick; a failure queues a run with trigger `health` if `health_triggers_run`.

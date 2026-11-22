# web/ — the Next.js web app (optional)

Goal pages and webhooks over the same `tasks.db` as the MCP server.

```
app/          — Next.js App Router pages and API routes
components/   — React components (GoalView, NewGoalButton)
lib/          — DB layer, goal views, request guard, WebSocket broadcaster
__tests__/    — Vitest test suites
server.ts     — Custom HTTP + WebSocket server
```

**Database layer** (`lib/db.ts`): shared plan/task queries come from `@quarterdeck/core` via a lazy `getDb()`. Adds web-only queries: approval stats, the event log, and the suggestions (`getAutonomySuggestions`, last 10 decisions all approvals: "Switch to auto" for a `propose` category, "Keep auto" after outside text for an `auto` one not yet in `auto_after_outside`, counting only proposals a marked run made of its auto actions, `state.outside_text`, #189). Schema changes go in `core/src/migrate.ts` (re-exported by `lib/migrate.ts`), never here. Human edits write history with `recordEvent()` (`actor: 'human'`).

**Real-time updates**: SQLite triggers bump `plans.revision` on every task insert/update/delete and plan update, from any process. `lib/mcp-poller.ts` checks each watched plan's revision once a second and broadcasts `mcp_update` through `lib/ws-broadcaster.ts` when it changes. The custom server (`server.ts`) routes WebSocket upgrades for `/api/plans/:id/ws` (the goal page's live updates; a goal is a plan).

**Request guard** (`lib/request-guard.ts`): `server.ts` rejects HTTP requests (403) and WebSocket upgrades whose `Host` isn't localhost/127.0.0.1/[::1] at the server's port, or whose `Origin` is present but foreign. This stops other websites from driving the local API (which can queue goal runs). Allow extra hosts with `QUARTERDECK_ALLOWED_HOSTS=host:port,...`.

**No runs here**: the web app never starts goal runs. Run now, webhooks and failing health checks only queue a run; the quarterdeck-goals plugin starts it at its next tick. Item approve/reject live at `/api/goals/:id/items/:itemId/{approve,reject}`; the approve route queues a run.

Goals are hidden from plan lists (`/api/plans`, home page, MCP `list_plans`).

**Tests** live in `__tests__/`. `vitest.config.ts` sets `QUARTERDECK_DB=:memory:`. Each test gets a clean slate via `beforeEach` in `__tests__/setup.ts`, which calls `clearAllData()` and `resetDb()`.

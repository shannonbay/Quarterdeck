# plugins/ — the Claude Code plugins

`quarterdeck-goals` (goal runner, Goals pane, status line, alerts, `/goal*` commands, tools Claude can call, and the bundled MCP server) and `quarterdeck-guard` (what a goal run may do). READMEs in each folder. Both work over the quarterdeck MCP server's tools via `$.tool.call` (mainly `goals_overview`, which answers `changed: false` to a matching etag). No web app needed. Goal behaviour is in `.claude/rules/goals-engine.md`, the guard in `.claude/rules/guard.md`.

**Loading edits**: installed as `quarterdeck-goals@quarterdeck` from this repo's marketplace, the plugin is read straight from the folder, so `/reload-plugins` picks up edits to the plugins' own files (hooks, commands, agents). It does not restart the bundled MCP server: after a server rebuild, reconnect it in `/mcp` or restart Claude Code. Check each with `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>`.

## Engine rules that bite

- Functions that take `$` must be top-level and imported by name (no `import * as`).
- State atoms must be read in the file that declares them (hence `hooks/state.ts` accessors).
- Every gating hook gets a `.catch`.

## Release bundling limits

The release ships each plugin's hooks as one file, `hooks/register.jsx` (`scripts/bundle-hooks.mjs`, esbuild, not minified): Anthropic's plugin directory reads `$` only in the file that registers the hooks and blocks a `$` passed to a function in another file. For the same reason:
- no hooks file may name a type or variable `$` (the engine type is `Engine`) or a variable `h` or `Fragment` (JSX names);
- the guard's `tool.check` hook may only deny or `return next(e)`, never allow;
- a hook on a permission event (`classic.PermissionRequest`) must end in a plain `return next(e)`: awaiting `next(e)` and returning its result is a blocking finding ("couldn't confirm that the mod leaves a permission decision with the user").

## Pane conventions

- A goal with nothing for the person (`isQuiet` in `hooks/model.ts`) is one line until expanded, so tests press `toggle-<id>` before a quiet goal's controls.
- A plain button for an action (Pause, Delete, Ask…, Cancel) goes through `action()` in `hooks/pane.tsx`, which draws its label in the one action colour (`Button` has no colour prop; a `Text` child carries it); rows that are content you press (a goal's name, a to-do's text, ☐) stay plain `Button`s.
- An expanded goal keeps to short lines (`details` in `hooks/pane.tsx`): one facts line (`factsLine`: runs, model, ▸ watches, ▸ allow rules), sections closed behind ▸ with counts, rows clipped with `clip()` and pressed to open. Open/closed is `isOpen(view, key, byDefault)`: a `view.shown` key flips the default, so a section that opens by itself (a memory to trust, a watch that can't check) can still be closed. Tests press `memory-toggle-<id>`, `memory-row-<mid>`, `watches-toggle-<id>` before what they open.
- `$.ui.ask` takes at most 4 options.

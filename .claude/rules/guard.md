---
paths:
  - "core/src/guard.ts"
  - "core/src/goal-engine.ts"
  - "plugins/quarterdeck-guard/**"
  - "plugins/quarterdeck-goals/hooks/templates.ts"
  - "mcp/src/tools/goal_runner.ts"
---

# The guard: what a goal run may do

**Why a guard plugin**: the engine hides from a plugin the calls its own timers and buttons cause, so the runner can't see its own timer-started runs. The guard plugin identifies runs by `$.agent.list()` `spawnedBy` plus the description. It sets `run_scope`, applies the goal guard (`guard_check`), refuses the person-only tools (`decide_item`, `cancel_run`, ...) to agents and the model, and keeps run reports out of the chat.

## Tool maps and decisions (`core/src/guard.ts`, MCP `guard_check`)

Called by the guard plugin for each run's tool calls. `tool_map` maps tool-name patterns to categories. It denies `off` categories, and `propose` categories unless an approved proposal for that category is still being carried out (active, not completed): an approval covers its whole action however many calls it takes, until the run completes the item. Every decision is recorded in `goal_tool_calls`. Outside goal runs it allows everything.

**Command rules**: `Bash(git push*)` / `PowerShell(...)` matches a shell call when any simple command in it (`commandParts`: split at `&&`, `;`, `|`, `$(`..., leading `VAR=x` dropped) matches the glob, case-insensitively, and wins over a rule on the tool's name; without input none matches, so `standingAllowRules` never allows plain `Bash` for one. The GitHub fixer templates use them (`githubRules` in `hooks/templates.ts`): push and `gh pr create` are `code.pull_request`, other gh writes, `gh api` and `gh auth` are `github.write` (off). Name matching only, like the data rule.

The Issue Fixer's watches split issues by `author_association` (`issueWatch`, `TRUSTED_ASSOCIATIONS`): collaborators' issue numbers under "new issues", anyone else's as `<number> by <login>` under "new issues from others", which the run asks about (`ask_person`) before reading. Its "comments on its pull requests" watch (`prCommentWatch`) lists only trusted authors' comments and reviews on its open `issue-fix/` PRs as `<number> <id>`; a run acts on one through a proposed push and can't reply on GitHub (`github.write` off), so questions come to the person.

## "allow" only means Quarterdeck doesn't object

The guard plugin turns a deny into a refusal and otherwise passes the call on (`next(e)`), so Claude Code's own permission rules (allow rules, auto mode, a prompt) decide every call it doesn't refuse, `auto` and approved ones included. The plugin never answers allow (the plugin directory won't list one that does). Docs and UI copy must not say `auto` lets a call through; the pane's "Claude Code allow rules" (`goal_detail`) lists the allow rules a goal's `auto` tools need.

## Untrusted content

A tool that reads outside text marks the run (`goal_runs.untrusted_at` / `untrusted_source`, first source kept except `watch events`, which a later read replaces, `markRunUntrusted`), and from then on its `auto` categories act as `propose` in both `guardRun` and `addItem` (an auto `add_item` becomes a proposal, `untrusted` in the result), so injected text can't take an action nobody approved.

- Readers are `BUILTIN_UNTRUSTED` (WebFetch, WebSearch, the browsers, Gmail's get/search/download tools) plus any tool a goal maps to the reserved category `untrusted` (`UNTRUSTED_CATEGORY`: always allowed, never an action category, left out of the web autonomy list).
- A brief that hands out watch events marks the run too (`run.untrusted` in the brief, source `WATCH_EVENTS_SOURCE`); a status set by a run marked only by them gets no ⚠ on the goal's line, and the expanded card says "set … after reading watch events" (`watchEvents` in `toStatusNote`, `hooks/model.ts`), since every watch-started run reads them.
- The guard sees names, and a shell call's command, so `Bash` (curl, `gh issue view`) and `Read` of a download mark nothing unless mapped to `untrusted` (`Bash(gh issue view*)`).
- Memory a marked run writes (`remember`) carries the mark (`goal_memory.untrusted_source`), and a brief that hands it out marks its run (`memory <id> (written after …)`, `untrusted: true` on the entry), so injected text can't wait one run to skip the guard; memory left out of the brief marks nothing, and the person's own memory, feedback and answers are never marked.
- The person clears a mark with Trust (pane, MCP `trust_memory`, person-only) or on the web page (PATCH `trusted: true`, or rewriting the text).

## Quarterdeck's own data

A run's `Bash`/`PowerShell` command naming `.quarterdeck`/`.conductor`, `tasks.db` or `QUARTERDECK_DB`/`CONDUCTOR_DB` (or a custom `QUARTERDECK_DB` path), and a file tool's path inside those folders or at the database, are refused first in `guardRun`, whatever the tool map says (`touchesQuarterdeckData`, category `quarterdeck-data`, recorded). The guard plugin sends only `command`, `file_path`, `notebook_path`, `path` and `pattern` as `guard_check`'s `input` (`callInput`); an older server drops the key. It matches names, so a script in another file gets past it: roadmap 1.37 (sandbox) closes that. A goal whose `working_dir` is inside `~/.quarterdeck` can't use file tools on its own folder.

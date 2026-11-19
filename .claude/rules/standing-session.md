---
paths:
  - "mcp/src/runner-session.ts"
  - "mcp/src/cli.ts"
  - "mcp/src/doctor.ts"
  - "mcp/src/tests/runner*"
  - "core/src/guard.ts"
---

# The standing session (`mcp/src/runner-session.ts`)

CLI `quarterdeck runner install|uninstall|start|stop|status|ensure|attach`; Windows and Linux. It runs goals with no Claude Code window open. It is one ordinary Claude Code session (`claude --remote-control --session-id <ours>`; later starts `--resume` it while its transcript is under `RESUME_MAX_BYTES` (300 KB: every finished run reports back to it as a turn, #111, so a long transcript makes every turn cost more), so restarts stay one chat in the Claude app, and a resume that exits within 5 s falls back to a new id) in `~/.quarterdeck/runner`, in a hidden console (`conhost --headless`), which competes for the scheduler lease like any window, so the runner, guard and alerts need nothing special. Each start (new or `--resume`) passes `--append-system-prompt HANDBACK_PROMPT` (#111): Claude Code hands every finished goal-runner subagent's report back to this session as a turn, so the prompt asks for a one-line reply with no tool calls, and `RUNNER_PROMPT` makes the report itself just "Run <id> ended.". It has no double quotes, `%` or shell metacharacters (a test checks), since `spawnSession` on Windows quotes arguments without escaping. Removing the turn altogether needs runs outside this session (#114). A Task Scheduler task runs `launch.mjs` → `runner ensure` every 5 minutes: start if missing, restart when the build (`currentBuild`: plugin version + bundle time) differs from `state.json`, never while a run is going. The session is found by the console's process id in `state.json`. The MCP server rewrites `runner/cli-path` at start-up (`recordCliPath`) because an installed plugin's folder changes with its version, but not when `QUARTERDECK_DB` (or `CONDUCTOR_DB`) points elsewhere than the home's own database: the launcher runs the CLI without that setting, so a test build would migrate the person's database (seen 19 Nov 2026). `goals_overview` carries `standing: true` while that session holds the lease. The functions take `RunnerDeps`, so tests fake the computer.

To restart it while developing, run the task (`MSYS_NO_PATHCONV=1 schtasks /run /tn "Quarterdeck goals runner"` from Git Bash).

## Learned the hard way (Nov 2026)

- **Not `claude --bg`**: the background service retires a background session minutes after it finishes a turn (`~/.claude/daemon.log`: `bg retire … settled`), which stopped goals after every alert or phone reply.
- **Start it with PowerShell's `Start-Process`**: started by Node's `spawn` it exits within seconds.
- On Windows `install` and `start` go through the task (`startByTask`) so the session isn't a child of the window the command ran in.
- Don't put a `.claude/settings.json` in the runner folder: with one, the session came up but never ticked.

## Permissions

Tested Nov 2026, after the guard stopped allowing calls. Nobody is at this session to answer a prompt, so `install` uses `--permission-mode auto` unless given another (`DEFAULT_PERMISSION_MODE`; with no mode the session takes the person's default) and the session starts with `--allowedTools` for Quarterdeck's own server (`OWN_TOOL_RULES`), without which `dontAsk` refuses even `get_goal_brief`. It also gets the goals' own tools (`standingAllowRules` in `core/src/guard.ts`: every active goal's tool-map tools whose category isn't `off`; a glob inside a tool name becomes the names the guard has recorded), because auto mode refused an approved Gmail `trash_thread` there and left another call at a prompt nobody could answer; the guard still refuses `propose` ones until approved. `state.json` keeps the list and `ensure` restarts the session when it changes, never during a run. In `manual` every call waits (the prompt does reach the Claude app over Remote Control) and the run times out; the doctor warns (`modeWarning`).

## Linux

Spiked Nov 2026 on WSL2: plugins load, the lease and runs work, Remote Control connects, and it outlives turns. `claude` runs as the pane of a detached tmux session on Quarterdeck's own socket (`tmux -L quarterdeck`, session `quarterdeck-goals`, so the person's tmux server and its environment stay out of it); `state.json`'s pid is the pane's, and `pidAlive` checks it is still that pane's. A systemd user timer runs `quarterdeck-runner.service` (oneshot: `launch.mjs` → `ensure`) a minute after it starts and every 5 minutes; `install` and `start` go through `systemctl --user start` like `startByTask`. The tmux server starts in a scope of its own (`systemd-run --user --scope`, plain tmux without a user manager), so it isn't left in the service, which systemd logs as an unclean stop at every check; the service keeps **`KillMode=process`** anyway, because by default systemd ends everything a finished oneshot leaves in its cgroup, the tmux server included. Its `PATH` is the installing shell's with the installing Node first, because the plugin starts its server with plain `node` (an nvm default may be too old for `node:sqlite`).

A new folder stops at Claude Code's **workspace trust question** before any plugin loads; `startByTask` reads the pane (`screenText`) and points to `runner attach`. We don't write `hasTrustDialogAccepted` into `~/.claude.json`: Claude Code rewrites that file while running. Windows has the same question and no way to see it.

**WSL can't host it**: WSL powers the distro off about a minute after its last window closes (seen Nov 2026, WSL 2.6.3: `systemd-logind: The system will power off now!`), standing session and all; the timer restarts it when a window opens, which is no use. `install` and the doctor warn (`InstallDeps.wsl`, from `/proc/version`) and point to the Windows runner.

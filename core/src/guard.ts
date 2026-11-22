/**
 * Goal guard: decides whether a tool call made during a goal run is allowed,
 * by mapping the tool to an action category (goal.tool_map) and applying the
 * goal's autonomy. Called through the MCP tool guard_check by the
 * quarterdeck-guard plugin, which knows which subagent does which run.
 *
 *   off     → denied
 *   auto    → allowed
 *   propose → allowed while an approved proposal for that category is being
 *             carried out: as many calls as the action needs (trashing a
 *             sender's 40 threads, the clicks of an unsubscribe page), until
 *             the run marks the item done. Every call is still recorded.
 *
 * Calls outside goal runs, or to tools not in the map, are always allowed.
 *
 * Untrusted content: a tool that reads mail, a web page or the like (the
 * built-in list below, or one the goal maps to the reserved category
 * `untrusted`) marks the run, and from then on its `auto` categories act as
 * `propose`, so text written to steer the agent can't take an action nobody
 * approved. Reading more stays allowed, and an approved proposal still goes
 * through. The guard sees tool names, and for a shell tool the command: `Bash`
 * running curl, or `Read` of a downloaded file, marks nothing unless the goal
 * maps it to `untrusted` (`Bash(gh issue view*)`).
 *
 * Command rules: a tool map can name what a shell tool runs, `Bash(git push*)`,
 * so a goal that works through git and gh can still need approval to push or
 * open a pull request. Like the data rule below, it matches names: a script
 * that pushes gets past it, and a sandbox is what closes that.
 *
 * Quarterdeck's own data: a run may not touch Quarterdeck's folder
 * (`~/.quarterdeck`, or `~/.conductor` from before the rename) or its database,
 * wherever `QUARTERDECK_DB` puts it, whatever the goal's tool rules say. Writing
 * the database directly would let a run approve its own proposals or change its
 * own autonomy, and the runner folder holds what the standing session starts.
 * For this one rule the guard looks at a call's input: a shell command that
 * names the folder, the database file or the variables that point to it, and a
 * file tool's path inside the folder. Matching names can be got around (a
 * script written to another file, a path spelled another way); a sandbox for
 * goal runs is what closes that.
 *
 * "allow" means only that Quarterdeck doesn't object: the plugin passes such a
 * call on to Claude Code's own permission rules, which decide it. It never
 * answers allow itself.
 */
import { homedir } from 'os'
import { join, posix } from 'path'
import type { Database } from './sqlite.js'
import { defaultDbPath } from './paths.js'
import { autonomyFor } from './goal-engine.js'
import { afterOutsideApplies, getGoal, getRun, markRunSecretsRead, markRunUntrusted, newId, secretsReadReason } from './goals.js'
import { consumeGuardedCheck, hasUnusedGuardedCheck } from './guarded.js'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import type { Goal, GoalRun, ToolCallRecord } from './types.js'

export type GuardDecision =
  | { decision: 'allow'; category?: string; run_id?: string }
  | { decision: 'deny'; category: string; run_id: string; reason: string }

/** The quarterdeck MCP server's tool prefix when it is set up by hand (`claude mcp add`). */
export const QUARTERDECK_TOOL_PREFIX = 'mcp__quarterdeck__'
/** Its prefix when the quarterdeck-goals plugin provides the server (Claude Code names plugin servers this way). */
export const PLUGIN_QUARTERDECK_TOOL_PREFIX = 'mcp__plugin_quarterdeck-goals_quarterdeck__'

/** A quarterdeck tool's name under either prefix, as `mcp__quarterdeck__<tool>`; other names unchanged. */
export function canonicalToolName(name: string): string {
  return name.startsWith(PLUGIN_QUARTERDECK_TOOL_PREFIX) ? QUARTERDECK_TOOL_PREFIX + name.slice(PLUGIN_QUARTERDECK_TOOL_PREFIX.length) : name
}

/** A glob (`*` for anything) as a whole-string regular expression. */
function globRegExp(pattern: string, flags = ''): RegExp {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', flags)
}

/** A rule on what a shell tool runs, as Claude Code writes them: `Bash(git push*)`, `PowerShell(gh pr create*)`. */
const COMMAND_RULE = /^(\w+)\(([\s\S]+)\)$/
/** A leading variable assignment (`GIT_SSH=x git push`). */
const ENV_PREFIX = /^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/
/** A whole word in one pair of matching quotes, with no whitespace or quote inside. */
const QUOTED_WORD = /(^|\s)(["'])([^\s"']+)\2(?=\s|$)/g

/**
 * A shell command's simple commands, each as it starts: split at `&&`, `||`,
 * `;`, `|`, `&`, new lines, `$(`, `(` and backticks, without leading variable
 * assignments. A word wholly wrapped in one pair of matching quotes, with no
 * whitespace or quote inside (`"needs-refinement"`, `'bug'`), is unwrapped,
 * since the shell runs it the same as the bare word; any other quoting is
 * left as written. Rough on purpose: a rule matching a part that isn't really a
 * command only refuses a call, which is the safe way to be wrong.
 */
export function commandParts(command: string): string[] {
  return command.split(/&&|\|\||\$\(|[;|&\n`(){}]/)
    .map((s) => s.trim().replace(ENV_PREFIX, '').trim().replace(QUOTED_WORD, '$1$3'))
    .filter(Boolean)
}

/**
 * Matches a tool name against "exact" or glob ("mcp__gmail__send*") patterns; exact patterns win.
 * Quarterdeck's own tools match under either prefix (see canonicalToolName).
 *
 * A command rule (`Bash(git push*)`) matches a shell call when any simple
 * command in it matches the glob (ignoring case, as PowerShell does), and wins
 * over a rule on the tool's name. Without `input` no command rule matches.
 */
export function matchToolCategory(rawMap: Record<string, string>, rawName: string, input?: Record<string, unknown>): string | null {
  return matchToolRule(rawMap, rawName, input)?.category ?? null
}

/** The rule matchToolCategory picks, with its pattern (as written in the map, canonical tool name). */
export function matchToolRule(rawMap: Record<string, string>, rawName: string, input?: Record<string, unknown>): { category: string; pattern: string } | null {
  const toolName = canonicalToolName(rawName)
  const toolMap = Object.fromEntries(Object.entries(rawMap).map(([p, c]) => [canonicalToolName(p), c]))
  const command = typeof input?.command === 'string' ? input.command : ''
  if (command) {
    const parts = commandParts(command)
    const rules = Object.entries(toolMap)
      .map(([p, c]) => [COMMAND_RULE.exec(p), c] as const)
      .filter(([m]) => m && m[1] === toolName)
      .sort(([a], [b]) => b![2].length - a![2].length) // most specific first
    for (const [m, category] of rules) {
      const re = globRegExp(m![2].trim(), 'i')
      if (parts.some((p) => re.test(p))) return { category, pattern: m![0] }
    }
  }
  if (toolMap[toolName]) return { category: toolMap[toolName], pattern: toolName }
  const globs = Object.entries(toolMap)
    .filter(([p]) => p.includes('*') && !COMMAND_RULE.test(p))
    .sort(([a], [b]) => b.length - a.length) // most specific first
  for (const [pattern, category] of globs) {
    if (globRegExp(pattern).test(toolName)) return { category, pattern }
  }
  return null
}

/** The reserved tool-rule category for a tool that reads untrusted content: never refused, it marks the run. */
export const UNTRUSTED_CATEGORY = 'untrusted'

/**
 * Tools that read untrusted content whatever the goal's tool rules say: web
 * fetches and searches, the browsers, and Gmail's readers (under either
 * spelling of the connector's or a server's name).
 */
export const BUILTIN_UNTRUSTED: readonly string[] = [
  'WebFetch', 'WebSearch',
  'mcp__claude-in-chrome__*', 'mcp__*Claude_Browser__*',
  ...['get_*', 'search_*', 'list_drafts', 'download_*'].flatMap((t) => [`mcp__*Gmail*__${t}`, `mcp__*gmail*__${t}`]),
]
const BUILTIN_UNTRUSTED_MAP = Object.fromEntries(BUILTIN_UNTRUSTED.map((p) => [p, UNTRUSTED_CATEGORY]))

/** Whether a tool reads untrusted content: the built-in list, or the goal maps it to `untrusted`. */
export function readsUntrusted(toolMap: Goal['tool_map'], toolName: string, input?: Record<string, unknown>): boolean {
  return untrustedLabel(toolMap, toolName, input) !== null
}

/**
 * What a call that reads untrusted content marks its run with, or null when it reads
 * nothing untrusted. A command rule names the rule that matched (`Bash: gh issue view`
 * for `Bash(gh issue view*)`); a name-only rule and the built-in readers give the tool name.
 */
export function untrustedLabel(toolMap: Goal['tool_map'], toolName: string, input?: Record<string, unknown>, ownOrigin: string | null = null): string | null {
  const rule = matchToolRule(toolMap, toolName, input)
  if (rule?.category === UNTRUSTED_CATEGORY) {
    const command = COMMAND_RULE.exec(rule.pattern)
    if (command) {
      const pattern = trimTrailing(command[2].trim(), '*').trim()
      return pattern ? `${command[1]}: ${pattern}` : command[1]
    }
    return toolName
  }
  if (matchToolCategory(BUILTIN_UNTRUSTED_MAP, toolName) !== null) return toolName
  // A rule of any category (trusted-read included) wins over the built-in network list, but a
  // command rule decides only the parts it names: `git status && curl x` still marks for curl.
  // A name-only rule (`Bash: web.read`) decides the whole command.
  let network: string | null = null
  if (SHELL_TOOLS.has(toolName) && typeof input?.command === 'string' && !(rule && !COMMAND_RULE.test(rule.pattern))) {
    for (const part of rule ? commandParts(input.command) : [input.command]) {
      if (rule && matchToolRule(toolMap, toolName, { command: part }) !== null) continue
      network = builtinNetworkPart(part, ownOrigin)
      if (network !== null) break
    }
  }
  return network !== null ? `${toolName}: ${network} (built-in network command)` : null
}

/**
 * The reserved tool-rule category for a command the goal trusts to reach the network
 * (`Bash(git fetch*)` in a goal that fetches only its own repo): never refused, it marks nothing (#173).
 */
export const TRUSTED_READ_CATEGORY = 'trusted-read'

/**
 * Shell commands that reach the network, matched per simple command ignoring case: they
 * mark the run unless the goal's tool map names the command (#173). `gh api` with a method
 * other than GET and git's own-origin fetches are left out (see builtinNetworkPart).
 */
export const BUILTIN_NETWORK: readonly string[] = [
  'curl*', 'wget*', 'Invoke-WebRequest*', 'iwr *', 'Invoke-RestMethod*', 'irm *', 'ssh *', 'scp *', 'nc *', 'ncat *',
  'npm install*', 'npm i *', 'npm view*', 'npm info*', 'npx *', 'pip install*', 'pip download*',
  'gh api*',
  'git clone*', 'git fetch*', 'git pull*', 'git ls-remote*',
]
const BUILTIN_NETWORK_RES = BUILTIN_NETWORK.map((p) => [p, globRegExp(p, 'i')] as const)

/** A remote URL without its scheme, credentials, trailing slash and `.git`, lower-cased, for comparing. */
function normaliseRemote(url: string): string {
  return trimTrailing(url.trim().replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/:(?!\d)/, '/'), '/').replace(/\.git$/i, '').toLowerCase()
}

/**
 * A string without the run of `ch` at its end. A loop, not `/x+$/`: that regex is
 * slow on a long run of `ch` that isn't at the end (CodeQL polynomial regex).
 */
export function trimTrailing(s: string, ch: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === ch) end--
  return s.slice(0, end)
}

/** Whether a git network command (`git fetch`, `git pull`, `git ls-remote`, `git clone`) uses only the goal's own origin. */
function gitOwnRemote(part: string, ownOrigin: string | null): boolean {
  const words = part.split(/\s+/).slice(2).filter((w) => !w.startsWith('-'))
  if (/^git\s+clone\b/i.test(part)) return ownOrigin !== null && words.length > 0 && normaliseRemote(words[0]) === normaliseRemote(ownOrigin)
  const remote = words[0]
  if (remote === undefined || remote.toLowerCase() === 'origin') return true
  return ownOrigin !== null && normaliseRemote(remote) === normaliseRemote(ownOrigin)
}

/**
 * The first simple command in a shell command that the built-in network list marks, as
 * the list's pattern without its `*` (`curl`, `git clone`), or null. `ownOrigin` is the
 * goal's working folder's origin URL, so a fetch from it marks nothing.
 */
export function builtinNetworkPart(command: string, ownOrigin: string | null = null): string | null {
  for (const part of commandParts(command)) {
    const hit = BUILTIN_NETWORK_RES.find(([, re]) => re.test(part))
    if (!hit) continue
    const name = hit[0].replace(/\*$/, '').trim()
    if (/^gh\s+api\b/i.test(part)) {
      const method = /(?:^|\s)(?:-X|--method)(?:\s+|=)(\S+)/.exec(part)?.[1]
      if (method && method.replace(/["']/g, '').toUpperCase() !== 'GET') continue
    }
    if (/^git\s/i.test(part) && gitOwnRemote(part, ownOrigin)) continue
    return name
  }
  return null
}

const originCache = new Map<string, string | null>()
/** The working folder's `origin` URL, or null when it has none (cached per folder). */
export function originUrl(workingDir: string): string | null {
  if (!originCache.has(workingDir)) {
    let url: string | null = null
    try { url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null } catch { url = null }
    originCache.set(workingDir, url)
  }
  return originCache.get(workingDir)!
}

/** The reserved category a refusal to touch Quarterdeck's own data is recorded under. */
export const QUARTERDECK_DATA_CATEGORY = 'quarterdeck-data'
/** The reserved category a refusal to read secrets in a marked run holding auto_after_outside is recorded under (#159). */
export const SECRETS_CATEGORY = 'secrets'

/** Where Quarterdeck keeps its data: its folders, and the database file wherever it is. */
export interface QuarterdeckDataPaths {
  /** `~/.quarterdeck` and `~/.conductor`. */
  dirs: string[]
  /** The database file (with its `-wal` and `-shm` files) when `QUARTERDECK_DB` puts it elsewhere. */
  db: string | null
}

export function quarterdeckDataPaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): QuarterdeckDataPaths {
  const db = defaultDbPath(env, home)
  const dirs = [join(home, '.quarterdeck'), join(home, '.conductor')]
  const inDirs = dirs.some((d) => isInside(normPath(db), normPath(d)))
  return { dirs, db: db === ':memory:' || inDirs ? null : db }
}

/** A path compared case- and slash-insensitively, as the to-do lists compare folders. */
const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir + '/')
/** `path` against `base`, with either slash and a drive letter or not, the same on every platform. */
function resolvePath(base: string, path: string): string {
  const p = path.replace(/\\/g, '/')
  return posix.normalize(/^([a-z]:)?\//i.test(p) ? p : posix.join(base.replace(/\\/g, '/'), p))
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])
/** A path segment naming Quarterdeck's folder (`~/.quarterdeck`, `$HOME\.conductor`, `cd .quarterdeck`). */
const DATA_DIR_SEGMENT = /(^|[\\/\s"'`=])\.(quarterdeck|conductor)(?![\w-])/i
/** The database's file name, with or without its -wal/-shm files. */
const DB_FILE_NAME = /(^|[\\/\s"'`=])tasks\.db(-wal|-shm)?(?![\w.-])/i
/** The variables that say where the database is. */
const DB_VARIABLE = /\b(QUARTERDECK|CONDUCTOR)_DB\b/i

/**
 * What a call would touch of Quarterdeck's own data, or null: a shell command
 * naming its folder, database file or the variables that point to it, or a
 * file tool's path inside the folder or at the database.
 */
export function touchesQuarterdeckData(
  toolName: string,
  input: Record<string, unknown> | undefined,
  workingDir: string,
  paths: QuarterdeckDataPaths = quarterdeckDataPaths(),
  home: string = homedir(),
): string | null {
  if (!input) return null
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (SHELL_TOOLS.has(toolName)) {
    const command = str('command')
    if (!command) return null
    const found = DATA_DIR_SEGMENT.exec(command) ?? DB_FILE_NAME.exec(command) ?? DB_VARIABLE.exec(command)
    if (found) return found[0].replace(/^[\\/\s"'`=]/, '')
    if (paths.db && normPath(command).includes(normPath(paths.db))) return paths.db
    return null
  }
  if (FILE_TOOLS.has(toolName)) {
    const fields = ['file_path', 'notebook_path', 'path', ...(toolName === 'Glob' ? ['pattern'] : [])]
    const base = str('path') || workingDir
    for (const field of fields) {
      const raw = str(field)
      if (!raw) continue
      const expanded = raw.replace(/^~(?=$|[\\/])/, home)
      const full = normPath(resolvePath(field === 'pattern' ? base : workingDir, expanded))
      if (paths.dirs.some((d) => isInside(full, normPath(d)))) return raw
      if (/(^|\/)tasks\.db(-wal|-shm)?$/.test(full)) return raw
      if (paths.db && [paths.db, `${paths.db}-wal`, `${paths.db}-shm`].some((f) => full === normPath(f))) return raw
      if (DATA_DIR_SEGMENT.test(raw)) return raw
    }
  }
  return null
}

/** Known secret locations a marked run holding auto_after_outside may not read (#159): ~/.ssh, ~/.aws, ~/.npmrc, ~/.config/gh, .env files. */
const SECRET_PATH = /(^|[\\/\s"'`=])(\.ssh|\.aws|\.npmrc|\.config[\\/]gh|\.env(\.[\w.-]*)?)(?![\w-])/i
/** Commands that print secrets: env, printenv, gh auth token, PowerShell's env: drive. */
const SECRET_COMMAND = /^(env|printenv)(\s|$)|^gh\s+auth\s+token\b|^(get-childitem|gci|ls|dir|cat|type|get-content|gc)\s+env:/i

/**
 * The known secret location or command a call names, or null: a shell command
 * naming a secret location or running a command that prints secrets, or a file
 * tool's path at one. Rough on purpose, like touchesQuarterdeckData: a false
 * match only refuses.
 */
export function touchesSecrets(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (SHELL_TOOLS.has(toolName)) {
    const command = str('command')
    if (!command) return null
    const found = SECRET_PATH.exec(command)
    if (found) return found[2]!
    for (const part of commandParts(command)) {
      if (SECRET_COMMAND.test(part)) return part
    }
    return null
  }
  if (FILE_TOOLS.has(toolName)) {
    for (const field of ['file_path', 'notebook_path', 'path', 'pattern']) {
      if (SECRET_PATH.test(str(field))) return str(field)
    }
  }
  return null
}

/** A `.env` file name: the secret files whose values guarded_run can recover and check for (#169). */
const ENV_FILE = /(?:^|[\s"'`=])((?:[^\s"'`=]*[\\/])?\.env(?:\.[\w.-]*)?)(?![\w-])/gi

/**
 * The secret files a call reads that guarded_run can check a payload against
 * (#169): a file tool's path, or the `.env` files a shell command names,
 * resolved against the working folder.
 */
export function secretFilePaths(toolName: string, input: Record<string, unknown> | undefined, workingDir: string): string[] {
  if (!input) return []
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const found: string[] = []
  if (FILE_TOOLS.has(toolName)) {
    const p = str('file_path') || str('notebook_path')
    if (p && SECRET_PATH.test(p)) found.push(p)
  } else if (SHELL_TOOLS.has(toolName)) {
    for (const m of str('command').matchAll(ENV_FILE)) found.push(m[1]!)
  }
  return [...new Set(found.map((p) => resolvePath(workingDir, p)))]
}

function record(db: Database, run: GoalRun, toolName: string, category: string, decision: 'allow' | 'deny' | 'refused', reason: string | null): void {
  db.prepare(`
    INSERT INTO goal_tool_calls (id, plan_id, run_id, tool_name, category, decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('tc'), run.plan_id, run.id, toolName, category, decision, reason, new Date().toISOString())
}

/**
 * Guard for a call made by a goal run's agent, by the run's id. `input` is the
 * call's input (the plugin sends the command and path fields), for the rule on
 * Quarterdeck's own data.
 */
/** Recorded as the reason on a call the guard let through after outside content because the person allowed it (#159). */
export const AFTER_OUTSIDE_NOTE = 'went through after outside content because you allowed it (checked by guarded_run)'

const readStaged = (path: string): Buffer | null => { try { return readFileSync(path) } catch { return null } }

export function guardToolCallForRun(
  db: Database, runId: string, toolName: string,
  input?: Record<string, unknown>, paths: QuarterdeckDataPaths = quarterdeckDataPaths(),
): GuardDecision {
  const run = db.prepare("SELECT * FROM goal_runs WHERE id = ? AND status IN ('queued', 'running')").get(runId) as GoalRun | undefined
  return run ? guardRun(db, run, toolName, input, paths) : { decision: 'allow' }
}

function guardRun(db: Database, run: GoalRun, toolName: string, input: Record<string, unknown> | undefined, paths: QuarterdeckDataPaths): GuardDecision {
  const goal = getGoal(db, run.plan_id)
  if (!goal) return { decision: 'allow' }
  const workingDir = (db.prepare('SELECT working_dir FROM plans WHERE id = ?').get(run.plan_id) as { working_dir: string } | undefined)?.working_dir ?? process.cwd()
  // A category the person let stay auto after outside content (#159): a command guarded_run checked and
  // staged (naming its copies in the data folder) goes through once, made exactly as it was returned
  const command = SHELL_TOOLS.has(toolName) && typeof input?.command === 'string' ? input.command : null
  const listed = matchToolCategory(goal.tool_map, toolName, input)
  let guardedMiss: string | null = null
  // A run that read secrets loses the setting (#169): nothing it stages goes through
  const afterOutside = afterOutsideApplies(run)
  if (afterOutside && command !== null && listed !== null && listed !== UNTRUSTED_CATEGORY && listed !== TRUSTED_READ_CATEGORY && autonomyFor(goal, listed) === 'auto'
    && goal.auto_after_outside.includes(listed) && hasUnusedGuardedCheck(db, run.id, command)) {
    const match = consumeGuardedCheck(db, run.id, listed, command, readStaged)
    if (match.ok) {
      record(db, run, toolName, listed, 'allow', AFTER_OUTSIDE_NOTE)
      return { decision: 'allow', category: listed, run_id: run.id }
    }
    guardedMiss = match.reason
  }
  const touched = touchesQuarterdeckData(toolName, input, workingDir, paths)
  if (touched !== null) {
    const reason = `Quarterdeck goal guard: a goal run can't read or change Quarterdeck's own data (${touched}). Use the goal tools (add_item, remember, end_run) instead, and don't try another way round.`
    record(db, run, toolName, QUARTERDECK_DATA_CATEGORY, 'deny', reason)
    return { decision: 'deny', category: QUARTERDECK_DATA_CATEGORY, run_id: run.id, reason }
  }
  // A marked run holding the setting may not read known secret locations: a guarded call could carry them out (#159).
  // Before the mark, a secret read is allowed but recorded, and the setting stops applying to the run (#169)
  if (goal.auto_after_outside.length > 0) {
    const secret = touchesSecrets(toolName, input)
    if (secret !== null) {
      if (getRun(db, run.id)?.untrusted_source) {
        const reason = `Quarterdeck goal guard: this run has read outside content and its goal keeps some categories auto after that, so it can't read secrets (${secret}). Do the work without them, and don't try another way round.`
        record(db, run, toolName, SECRETS_CATEGORY, 'deny', reason)
        return { decision: 'deny', category: SECRETS_CATEGORY, run_id: run.id, reason }
      }
      for (const path of secretFilePaths(toolName, input, workingDir)) markRunSecretsRead(db, run.id, secret, path)
      markRunSecretsRead(db, run.id, secret)
    }
  }
  const category = matchToolCategory(goal.tool_map, toolName, input)
  const untrustedRead = untrustedLabel(goal.tool_map, toolName, input, category === null && command !== null ? originUrl(workingDir) : null)
  if (untrustedRead !== null) markRunUntrusted(db, run.id, untrustedRead)
  if (!category) {
    // A built-in network mark is recorded, so the doctor and goal_detail can list the command to map (#173)
    const network = untrustedRead?.endsWith(' (built-in network command)') ? untrustedRead.slice(untrustedRead.indexOf(': ') + 2, -' (built-in network command)'.length) : null
    if (network !== null) record(db, run, toolName, UNTRUSTED_CATEGORY, 'allow', `built-in network command: ${network}`)
    return { decision: 'allow', run_id: run.id }
  }
  if (category === TRUSTED_READ_CATEGORY) return { decision: 'allow', category, run_id: run.id }
  if (category === UNTRUSTED_CATEGORY) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }

  const mode = autonomyFor(goal, category)
  // Once the run has read untrusted content, its auto categories need approval like propose ones
  const untrusted = mode === 'auto' ? getRun(db, run.id)?.untrusted_source ?? null : null
  if (mode === 'auto' && untrusted === null) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }
  const secretsOff = mode === 'auto' && goal.auto_after_outside.includes(category) && !afterOutsideApplies(getRun(db, run.id))
  if (guardedMiss === null && !secretsOff && mode === 'auto' && goal.auto_after_outside.includes(category)) {
    guardedMiss = 'this call was not staged by guarded_run'
  }
  if (mode === 'off') {
    const reason = `Quarterdeck goal guard: "${category}" is off for this goal, so ${toolName} is not allowed. Don't take or propose this action.`
    record(db, run, toolName, category, 'deny', reason)
    return { decision: 'deny', category, run_id: run.id, reason }
  }

  // propose: allowed while an approved proposal for this category is still being carried out
  // (active and not done). One action can take many calls; completing the item ends it.
  const approved = (db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE plan_id = ? AND status = 'active' AND archived_at IS NULL AND approved_at IS NOT NULL
      AND json_extract(state, '$.action.category') = ?
  `).get(run.plan_id, category) as { n: number }).n
  if (approved > 0) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }
  const how = `Propose it with add_item (action.category "${category}") and wait until it shows approved_to_execute; once approved, carry it out and then complete the item.`
  const guardedHow = secretsOff ? ` You let "${category}" stay auto after outside content, but ${secretsReadReason(getRun(db, run.id)!, category)}.`
    : guardedMiss !== null ? ` You let "${category}" stay auto after outside content, but only for a call guarded_run has checked and staged, made exactly as it returned it (${guardedMiss}).` : ''
  const reason = untrusted !== null
    ? `Quarterdeck goal guard: this run has read untrusted content (${untrusted}), so "${category}" needs approval for the rest of the run, in case that content asked for it.${guardedHow} ${how}`
    : `Quarterdeck goal guard: "${category}" needs approval first. ${how}`
  record(db, run, toolName, category, 'deny', reason)
  return { decision: 'deny', category, run_id: run.id, reason }
}

/**
 * Whether a shell command rule (`Bash(...)`, `PowerShell(...)`) is one Claude
 * Code takes cleanly as an allow rule as written: its first `*` comes after the
 * program and at least one more word that isn't a flag (a subcommand), as in
 * `Bash(git push*)` or `Bash(gh api repos/*\/pulls/*\/comments*)`. Claude Code
 * warns about a `*` right after the program or a flag (`Bash(ls*)`,
 * `Bash(git -C * push*)`), so those stay out. PowerShell matches
 * case-insensitively, as the guard does. The pane keeps a copy
 * (commandAllowRule in plugins/quarterdeck-goals/hooks/model.ts).
 */
export function commandAllowRule(pattern: string): boolean {
  const m = /^(?:Bash|[Pp][Oo][Ww][Ee][Rr][Ss][Hh][Ee][Ll][Ll])\(([\s\S]*)\)$/.exec(pattern)
  if (!m) return false
  const star = m[1].indexOf('*')
  if (star < 0) return true
  const words = m[1].slice(0, star).trim().split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.slice(1).some((w) => !w.startsWith('-'))
}

/** What recordRefusal stored: the category, and the allow rule the call needs (null when Claude Code can't take one). */
export interface RecordedRefusal {
  category: string
  rule: string | null
}

/**
 * Records a call of a goal run that the guard allowed but Claude Code refused
 * (its PermissionDenied hook), as decision `refused` with the allow rule it needs
 * as the reason: the matched tool-map pattern when Claude Code takes it as a rule
 * (commandAllowRule), otherwise the plain tool name, or none for a shell call whose
 * rule it can't take. Records nothing, and returns null, for a call that maps to no
 * category or that the guard would have refused itself (#145).
 */
export function recordRefusal(
  db: Database, runId: string, toolName: string,
  input?: Record<string, unknown>, paths: QuarterdeckDataPaths = quarterdeckDataPaths(),
): RecordedRefusal | null {
  const run = db.prepare("SELECT * FROM goal_runs WHERE id = ? AND status IN ('queued', 'running')").get(runId) as GoalRun | undefined
  const goal = run ? getGoal(db, run.plan_id) : null
  if (!run || !goal) return null
  const workingDir = (db.prepare('SELECT working_dir FROM plans WHERE id = ?').get(run.plan_id) as { working_dir: string } | undefined)?.working_dir ?? process.cwd()
  if (touchesQuarterdeckData(toolName, input, workingDir, paths) !== null) return null
  const matched = matchToolRule(goal.tool_map, toolName, input)
  if (!matched || matched.category === UNTRUSTED_CATEGORY || matched.category === TRUSTED_READ_CATEGORY) return null
  const { category, pattern } = matched
  const mode = autonomyFor(goal, category)
  if (mode === 'off') return null
  const untrusted = getRun(db, run.id)?.untrusted_source ?? null
  if (mode !== 'auto' || untrusted !== null) {
    const approved = (db.prepare(`
      SELECT COUNT(*) AS n FROM tasks
      WHERE plan_id = ? AND status = 'active' AND archived_at IS NULL AND approved_at IS NOT NULL
        AND json_extract(state, '$.action.category') = ?
    `).get(run.plan_id, category) as { n: number }).n
    if (approved === 0) return null
  }
  const rule = commandAllowRule(pattern) ? pattern : SHELL_TOOLS.has(toolName) ? null : toolName
  record(db, run, toolName, category, 'refused', rule)
  return { category, rule }
}

/**
 * Whether the standing session can start with a tool pattern as an allow rule
 * as it stands: a plain name, a whole server (`mcp__<server>__*`), or a shell
 * command rule commandAllowRule accepts, the forms Claude Code documents. A
 * glob inside a tool's name (`trash_*`) is left to the names seen, as a rule
 * Claude Code refuses could keep the session from starting at all.
 */
export function usableAsAllowRule(pattern: string): boolean {
  return !pattern.includes('*') || /^mcp__[^*]+?__\*$/.test(pattern) || commandAllowRule(pattern)
}

/**
 * The allow rules the standing session starts with besides Quarterdeck's own:
 * the tools every active goal maps to a category that isn't `off`. The guard
 * still refuses a `propose` one until its item is approved, so allowing them
 * here only stops Claude Code asking (or auto mode refusing) a second time,
 * where nobody is there to answer. A pattern Claude Code can't take
 * (`mcp__*Gmail*__trash_*`) becomes the names the guard has seen it match in
 * that goal's runs. Quarterdeck's own tools are left out (OWN_TOOL_RULES).
 */
export function standingAllowRules(db: Database): string[] {
  const rules = new Set<string>()
  const goals = db.prepare("SELECT g.plan_id FROM goals g JOIN plans p ON p.id = g.plan_id WHERE g.status = 'active'").all() as { plan_id: string }[]
  for (const { plan_id } of goals) {
    const goal = getGoal(db, plan_id)
    if (!goal) continue
    const allowed = (category: string | null) => category !== null && autonomyFor(goal, category) !== 'off'
    for (const [pattern, category] of Object.entries(goal.tool_map)) {
      if (allowed(category) && usableAsAllowRule(pattern)) rules.add(pattern)
    }
    const seen = db.prepare('SELECT DISTINCT tool_name FROM goal_tool_calls WHERE plan_id = ?').all(plan_id) as { tool_name: string }[]
    for (const { tool_name } of seen) {
      if (allowed(matchToolCategory(goal.tool_map, tool_name))) rules.add(tool_name)
    }
  }
  const own = [QUARTERDECK_TOOL_PREFIX, PLUGIN_QUARTERDECK_TOOL_PREFIX]
  return [...rules].filter((r) => !own.some((p) => r.startsWith(p))).sort()
}

export function listToolCalls(db: Database, planId: string, limit = 50): ToolCallRecord[] {
  return db.prepare('SELECT * FROM goal_tool_calls WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(planId, limit) as ToolCallRecord[]
}

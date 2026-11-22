/**
 * The rule checks guarded_run makes before it stages a call for a goal run
 * that has read outside content (#159). They run before the Haiku check, so a
 * payload that fails here never reaches the model.
 */

import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import type { Database } from './sqlite.js'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterOutsideApplies, newId, getGoal, getRun, runSecretPaths, secretsReadReason } from './goals.js'
import { autonomyFor } from './goal-engine.js'
import { matchToolCategory } from './guard.js'
import { getPlan } from './queries.js'

/** One file a guarded call needs, sent in full so the check sees what the call will send. */
export interface GuardedFile {
  path: string
  contents: string
}

/** The most a guarded call may carry, command plus every file's contents, in bytes. */
export const GUARDED_MAX_BYTES = 64 * 1024

/** Environment variable values shorter than this aren't checked (too likely to match by chance). */
export const ENV_VALUE_MIN_CHARS = 8

/** Known secret formats, by name. A match anywhere in the payload fails the check. */
const TOKEN_RULES: { name: string; re: RegExp }[] = [
  { name: 'a GitHub token (ghp_, gho_, ghu_, ghs_, ghr_)', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'a GitHub fine-grained token (github_pat_)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'an API key (sk-)', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'an AWS access key id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'a private key block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
]

export type GuardedCheck = { ok: true } | { ok: false; reason: string }

/**
 * Checks a guarded call's command and files: the size limit first, then the
 * known token formats, then the values (8+ characters) of the run's
 * environment variables. Returns why it failed, so the run can propose instead.
 */
export function checkGuardedPayload(
  command: string, files: GuardedFile[], env: Record<string, string | undefined> = process.env,
  secretFiles: SecretFileValues[] = [],
): GuardedCheck {
  const parts = [command, ...files.map((f) => f.contents)]
  const bytes = parts.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0)
  if (bytes > GUARDED_MAX_BYTES) {
    return { ok: false, reason: `the command and its files come to ${bytes} bytes, over the ${GUARDED_MAX_BYTES}-byte limit for a guarded call` }
  }
  const where = (i: number) => (i === 0 ? 'the command' : `file ${files[i - 1].path}`)
  for (const [i, text] of parts.entries()) {
    for (const rule of TOKEN_RULES) {
      if (rule.re.test(text)) return { ok: false, reason: `${where(i)} contains what looks like ${rule.name}` }
    }
  }
  const values = Object.entries(env)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length >= ENV_VALUE_MIN_CHARS)
  for (const [i, text] of parts.entries()) {
    for (const [name, value] of values) {
      if (text.includes(value)) return { ok: false, reason: `${where(i)} contains the value of the environment variable ${name}` }
    }
  }
  for (const [i, text] of parts.entries()) {
    for (const secret of secretFiles) {
      if (secret.values.some((v) => text.includes(v))) return { ok: false, reason: `${where(i)} contains a value from ${secret.path}, which this run read` }
    }
  }
  return { ok: true }
}

/** The values a secret file the run read holds (#169), which a guarded payload may not contain. */
export interface SecretFileValues { path: string; values: string[] }

/**
 * The values guarded_run can recover from a secret file (#169): each `KEY=VALUE`
 * line's value, and every other non-empty line, of ENV_VALUE_MIN_CHARS or more.
 * A file that can't be read gives none.
 */
export function secretFileValues(path: string): SecretFileValues {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return { path, values: [] } }
  const values = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const kv = /^(?:export\s+)?[A-Za-z_][\w.-]*\s*=\s*(.*)$/.exec(line)
    const value = kv ? kv[1]!.trim().replace(/^["']|["']$/g, '') : line
    if (value.length >= ENV_VALUE_MIN_CHARS) values.add(value)
  }
  return { path, values: [...values] }
}

/** The sha256 of a staged file's contents, as recorded and compared. */
export function hashContents(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

/** A check guarded_run passed: the exact staged command and each staged file's hash, good for one call. */
export interface GuardedCheckRecord {
  id: string
  plan_id: string
  run_id: string
  category: string
  command: string
  file_hashes: Record<string, string>
  used_at: string | null
  created_at: string
}

/** Records a passed check for a run, with the staged files (by their staged path) and their contents' hashes. */
export function recordGuardedCheck(
  db: Database, run: { id: string; plan_id: string }, category: string, command: string, staged: GuardedFile[],
): GuardedCheckRecord {
  const rec: GuardedCheckRecord = {
    id: newId('gc'), plan_id: run.plan_id, run_id: run.id, category, command,
    file_hashes: Object.fromEntries(staged.map((f) => [f.path, hashContents(f.contents)])),
    used_at: null, created_at: new Date().toISOString(),
  }
  db.prepare('INSERT INTO guarded_checks (id, plan_id, run_id, category, command, file_hashes, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(rec.id, rec.plan_id, rec.run_id, rec.category, rec.command, JSON.stringify(rec.file_hashes), rec.created_at)
  return rec
}

export type GuardedMatch = { ok: true; check: GuardedCheckRecord } | { ok: false; reason: string }

/**
 * Uses up the run's unused check for exactly this command in this category,
 * when each staged file still hashes as recorded (readFile gives its current
 * contents, or null when it is gone). A changed command, a changed or missing
 * file, or a check already used doesn't match. A match marks the check used.
 */
export function consumeGuardedCheck(
  db: Database, runId: string, category: string, command: string, readFile: (path: string) => string | Buffer | null,
): GuardedMatch {
  const rows = db.prepare('SELECT * FROM guarded_checks WHERE run_id = ? AND category = ? AND command = ? ORDER BY created_at, rowid')
    .all(runId, category, command) as (Omit<GuardedCheckRecord, 'file_hashes'> & { file_hashes: string })[]
  const unused = rows.filter((r) => r.used_at === null)
  if (rows.length === 0) return { ok: false, reason: 'no guarded_run check matches this exact command' }
  if (unused.length === 0) return { ok: false, reason: 'the guarded_run check for this command was already used; each check is good for one call' }
  const check: GuardedCheckRecord = { ...unused[0], file_hashes: JSON.parse(unused[0].file_hashes) as Record<string, string> }
  for (const [path, hash] of Object.entries(check.file_hashes)) {
    const now = readFile(path)
    if (now === null) return { ok: false, reason: `staged file ${path} is gone` }
    if (hashContents(now) !== hash) return { ok: false, reason: `staged file ${path} changed after guarded_run checked it` }
  }
  const usedAt = new Date().toISOString()
  db.prepare('UPDATE guarded_checks SET used_at = ? WHERE id = ? AND used_at IS NULL').run(usedAt, check.id)
  return { ok: true, check: { ...check, used_at: usedAt } }
}

/** Whether the run holds an unused check for exactly this command, in any category (without using it). */
export function hasUnusedGuardedCheck(db: Database, runId: string, command: string): boolean {
  return db.prepare('SELECT 1 FROM guarded_checks WHERE run_id = ? AND command = ? AND used_at IS NULL LIMIT 1').get(runId, command) !== undefined
}

/**
 * Ties a guarded check the run used for this category to the item recording
 * it: true once per used check, so one checked call records one auto item.
 */
export function claimUsedGuardedCheck(db: Database, runId: string, category: string): boolean {
  const row = db.prepare(`SELECT id FROM guarded_checks WHERE run_id = ? AND category = ? AND used_at IS NOT NULL AND recorded_at IS NULL ORDER BY used_at LIMIT 1`).get(runId, category) as { id: string } | undefined
  if (!row) return false
  db.prepare('UPDATE guarded_checks SET recorded_at = ? WHERE id = ?').run(new Date().toISOString(), row.id)
  return true
}

/** One exact call a proposal stages (#167): a command and the full contents of the files it sends. */
export interface ProposalCall {
  command: string
  files?: GuardedFile[]
}

/** The most calls one proposal may stage (#167). */
export const PROPOSAL_MAX_CALLS = 10

/** Why a proposal's calls can't be staged, or null when they can: too many, an empty command, or one over GUARDED_MAX_BYTES. */
export function proposalCallsProblem(calls: ProposalCall[]): string | null {
  if (calls.length > PROPOSAL_MAX_CALLS) return `a proposal can stage at most ${PROPOSAL_MAX_CALLS} calls (got ${calls.length})`
  for (const [i, c] of calls.entries()) {
    if (typeof c.command !== 'string' || !c.command.trim()) return `call ${i + 1} has no command`
    const bytes = Buffer.byteLength(c.command) + (c.files ?? []).reduce((n, f) => n + Buffer.byteLength(f.contents), 0)
    if (bytes > GUARDED_MAX_BYTES) return `call ${i + 1} carries ${bytes} bytes, over the ${GUARDED_MAX_BYTES}-byte limit`
  }
  return null
}

/** A target a guarded call writes to (#168): a repo as owner/name and a PR or issue number. */
export interface GuardedTarget { repo: string; number: number }

/** owner/name from a GitHub remote URL (https or ssh), lower-cased; null if it isn't one. */
export function normaliseRepo(url: string): string | null {
  // Read from the end with string steps, not one unanchored regex: that one is slow on
  // a long run of `github.com:` (CodeQL polynomial regex).
  let t = url.trim()
  if (t.endsWith('/')) t = t.slice(0, -1)
  const q = t.lastIndexOf('/')
  if (q < 0) return null
  let name = t.slice(q + 1)
  if (name.length > 4 && name.toLowerCase().endsWith('.git')) name = name.slice(0, -4)
  const head = t.slice(0, q)
  const p = head.lastIndexOf('/')
  const plain = (s: string) => s.length > 0 && !/\s/.test(s)
  if (!plain(name)) return null
  // https://github.com/owner/name: the whole host part must be github.com, so
  // evilgithub.com or evil.com/github.com don't pass (CodeQL incomplete URL sanitization)
  if (p >= 0) {
    const owner = head.slice(p + 1)
    return GITHUB_HOST.test(head.slice(0, p)) && plain(owner) ? `${owner}/${name}`.toLowerCase() : null
  }
  // git@github.com:owner/name: only a user@ may come before github.com:
  const k = head.toLowerCase().indexOf('github.com:')
  if (k < 0 || !/^(?:[\w.-]+@)?$/.test(head.slice(0, k))) return null
  const owner = head.slice(k + 'github.com:'.length)
  return plain(owner) ? `${owner}/${name}`.toLowerCase() : null
}

/** The host part of a GitHub URL, whole: an optional scheme and user, then github.com. */
const GITHUB_HOST = /^(?:(?:https?|ssh|git):\/\/)?(?:[\w.-]+@)?github\.com$/i

const repoCache = new Map<string, string | null>()

/** The goal's own repo, from `git remote get-url origin` in its working folder (cached per folder). */
export function goalRepo(workingDir: string | null): string | null {
  if (!workingDir) return null
  if (repoCache.has(workingDir)) return repoCache.get(workingDir)!
  let repo: string | null = null
  try {
    repo = normaliseRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }))
  } catch { repo = null }
  repoCache.set(workingDir, repo)
  return repo
}

/**
 * Every target a command names (#168), or null when one can't be read.
 * Matched on the whole command, since `commandParts` would split `{owner}/{repo}`.
 * `{owner}/{repo}` placeholders, and a gh pr/issue command without -R, are the goal's repo.
 */
export function guardedTarget(command: string, ownRepo: string): GuardedTarget[] | null {
  const targets: GuardedTarget[] = []
  const own = ownRepo.toLowerCase()
  const repoOf = (owner: string, name: string) => (owner === '{owner}' && name === '{repo}' ? own : `${owner}/${name}`.toLowerCase())
  let rest = command.replace(/https?:\/\/github\.com\/([^/\s'"]+)\/([^/\s'"]+)\/(?:pull|issues)\/(\d+)[^\s'"]*/g, (_all, o: string, n: string, num: string) => {
    targets.push({ repo: `${o}/${n}`.toLowerCase(), number: Number(num) })
    return ' __url__ '
  })
  rest = rest.replace(/\brepos\/([^/\s'"]+)\/([^/\s'"]+)\/(?:pulls|issues)\/(\d+)/g, (_all, o: string, n: string, num: string) => {
    targets.push({ repo: repoOf(o, n), number: Number(num) })
    return '__path__'
  })
  // Every gh api part of a chained command needs its own repos path, or one pinned call
  // would carry an unpinned one (`gh api repos/o/r/pulls/12/reviews && gh api repos/evil/x/gists`)
  // A lone `&` (background) separates parts too, so split on each of ; & | and newline
  for (const part of rest.split(/[;&|\n]/)) {
    if (/\bgh\s+api\b/.test(part) && !part.includes('__path__')) return null
  }
  for (const m of rest.matchAll(/\bgh\s+(?:pr|issue)\s+[a-z-]+((?:[^;&|\n])*)/g)) {
    let args = m[1]!
    let repo = own
    const r = /(?:^|\s)(?:-R|--repo)(?:\s+|=)['"]?([^\s'"]+)['"]?/.exec(args)
    if (r) {
      repo = (normaliseRepo(`github.com/${r[1]!.replace(/^(?:https?:\/\/)?github\.com\//i, '')}`) ?? r[1]!).toLowerCase()
      args = args.replace(r[0], ' ')
    }
    if (args.includes('__url__')) {
      if (r) for (const t of targets) if (t.repo !== repo) targets.push({ repo, number: t.number })
      continue
    }
    const n = /(?:^|\s)['"]?#?(\d+)['"]?(?=\s|$)/.exec(args)
    if (!n) return null
    targets.push({ repo, number: Number(n[1]) })
  }
  return targets.length > 0 ? targets : null
}

/** The PR and issue numbers a run was started for (#168): its watch lines' leading numbers and a number in its Run now request. */
export function runTargets(db: Database, runId: string): number[] {
  const out = new Set<number>()
  const rows = db.prepare('SELECT line FROM goal_watch_events WHERE run_id = ?').all(runId) as { line: string }[]
  for (const { line } of rows) {
    const m = /^\s*#?(\d+)/.exec(line)
    if (m) out.add(Number(m[1]))
  }
  const request = (getRun(db, runId) as { request?: string | null } | undefined)?.request
  if (request) {
    const m = /#(\d+)\b/.exec(request) ?? /(?:^|\s)(\d+)(?=\s|$|[.,;:!?])/.exec(request)
    if (m) out.add(Number(m[1]))
  }
  return [...out].sort((a, b) => a - b)
}

/** Why a command's target fails #168's pin (the goal's own repo, a number the run was started for), or null when it passes. */
export function checkGuardedTarget(command: string, ownRepo: string | null, allowed: number[]): string | null {
  if (allowed.length === 0) return "this run wasn't started for a PR or issue, so it can't make guarded calls: propose it instead"
  if (!ownRepo) return "the goal's repo can't be read from its working folder's origin remote, so it can't make guarded calls: propose it instead"
  const targets = guardedTarget(command, ownRepo)
  if (!targets) return "the call's target (a repo and a PR or issue number) can't be read from the command, so it can't be a guarded call: propose it instead"
  const set = allowed.map((n) => `#${n}`).join(', ')
  for (const t of targets) {
    if (t.repo !== ownRepo.toLowerCase()) return `the call names ${t.repo} #${t.number}, but this goal's repo is ${ownRepo}: propose it instead`
    if (!allowed.includes(t.number)) return `the call names #${t.number}, but this run was started for ${set}: propose it instead`
  }
  return null
}

/** The key a proposal's staged calls are stored under (#167): item ids are only unique within a goal. */
export const proposalKey = (planId: string, taskId: string): string => `${planId}/${taskId}`

/** Drops a proposal's staged calls and their files (#167), so an old approval can't be reused. */
export function clearProposalCalls(db: Database, key: string, dataDir: string): void {
  const gone = db.prepare('DELETE FROM guarded_checks WHERE task_id = ?').run(key) as { changes: number | bigint }
  if (Number(gone.changes) > 0) rmSync(join(dataDir, 'guarded', key.replace('/', '-')), { recursive: true, force: true })
}

/**
 * Stages a proposal's exact calls (#167): each file is written under
 * `<dataDir>/guarded/<task id>/`, the command's mentions of its original path
 * point at the copy, and one check per call is recorded against the item.
 * Earlier calls for the item are dropped first. Returns the staged commands,
 * the ones the run must make once the item is approved. No payload rules run:
 * the person approving is the check.
 */
export function stageProposalCalls(
  db: Database, task: { id: string; plan_id: string; run_id: string | null }, category: string,
  calls: ProposalCall[], opts: { dataDir: string },
): string[] {
  const problem = proposalCallsProblem(calls)
  if (problem) throw new Error(problem)
  const key = proposalKey(task.plan_id, task.id)
  clearProposalCalls(db, key, opts.dataDir)
  if (calls.length === 0) return []
  const dir = join(opts.dataDir, 'guarded', key.replace('/', '-'))
  mkdirSync(dir, { recursive: true })
  return calls.map((call, n) => {
    let staged = call.command
    const copies: GuardedFile[] = (call.files ?? []).map((f, i) => {
      const path = join(dir, `${n}-${i}-${basename(f.path.replace(/\\/g, '/'))}`)
      writeFileSync(path, f.contents)
      staged = staged.split(f.path).join(path)
      return { path, contents: f.contents }
    })
    const rec = recordGuardedCheck(db, { id: task.run_id ?? '', plan_id: task.plan_id }, category, staged, copies)
    db.prepare('UPDATE guarded_checks SET task_id = ? WHERE id = ?').run(key, rec.id)
    return staged
  })
}

/** A proposal's staged calls, in order, with whether each was used (#167). */
export function proposalCalls(db: Database, key: string): { command: string; files: string[]; used_at: string | null }[] {
  const rows = db.prepare('SELECT command, file_hashes, used_at FROM guarded_checks WHERE task_id = ? ORDER BY created_at, rowid').all(key) as { command: string; file_hashes: string; used_at: string | null }[]
  return rows.map((r) => ({ command: r.command, files: Object.keys(JSON.parse(r.file_hashes) as Record<string, string>), used_at: r.used_at }))
}

/**
 * A proposal's staged calls with each file's contents as staged now (null when
 * the file is gone), for the goal page, where the person reads what they approve (#167).
 */
export function proposalCallsWithFiles(db: Database, key: string): { command: string; files: { path: string; contents: string | null }[]; used_at: string | null }[] {
  return proposalCalls(db, key).map((c) => ({
    ...c,
    files: c.files.map((path) => {
      try { return { path, contents: readFileSync(path, 'utf8') } } catch { return { path, contents: null } }
    }),
  }))
}

/** Whether a proposal staged exact calls (#167); one that didn't covers its whole category. */
export function proposalHasCalls(db: Database, key: string): boolean {
  return db.prepare('SELECT 1 FROM guarded_checks WHERE task_id = ? LIMIT 1').get(key) !== undefined
}

/**
 * The approved proposal (active, not done) in this category with an unused
 * staged call for exactly this command (#167), with that call's staged file
 * copies, or null. The guard checks it before its rule on Quarterdeck's own
 * data, since staged copies live in the data folder.
 */
export function approvedStagedCall(
  db: Database, planId: string, category: string, command: string,
): { key: string; files: string[] } | null {
  const row = db.prepare(`
    SELECT g.task_id AS key, g.file_hashes AS file_hashes FROM guarded_checks g
    JOIN tasks t ON g.task_id = t.plan_id || '/' || t.id
    WHERE t.plan_id = ? AND t.status = 'active' AND t.archived_at IS NULL AND t.approved_at IS NOT NULL
      AND json_extract(t.state, '$.action.category') = ? AND g.command = ? AND g.used_at IS NULL
    ORDER BY t.created_at, t.rowid, g.created_at, g.rowid LIMIT 1
  `).get(planId, category, command) as { key: string; file_hashes: string } | undefined
  return row ? { key: row.key, files: Object.keys(JSON.parse(row.file_hashes) as Record<string, string>) } : null
}

/**
 * Uses up an approved proposal's unused staged call for exactly this command
 * when its staged files still hash as recorded (#167). Keyed by the item, not
 * the run, so a later run can carry out the approval.
 */
export function consumeProposalCall(
  db: Database, key: string, command: string, readFile: (path: string) => string | Buffer | null,
): GuardedMatch {
  const rows = db.prepare('SELECT * FROM guarded_checks WHERE task_id = ? AND command = ? ORDER BY created_at, rowid')
    .all(key, command) as (Omit<GuardedCheckRecord, 'file_hashes'> & { file_hashes: string })[]
  const unused = rows.filter((r) => r.used_at === null)
  if (rows.length === 0) return { ok: false, reason: 'no staged call of the approved proposal matches this exact command' }
  if (unused.length === 0) return { ok: false, reason: 'this staged call was already made; each is good for one call' }
  const check: GuardedCheckRecord = { ...unused[0], file_hashes: JSON.parse(unused[0].file_hashes) as Record<string, string> }
  for (const [path, hash] of Object.entries(check.file_hashes)) {
    const now = readFile(path)
    if (now === null) return { ok: false, reason: `staged file ${path} is gone` }
    if (hashContents(now) !== hash) return { ok: false, reason: `staged file ${path} changed after it was proposed` }
  }
  const usedAt = new Date().toISOString()
  db.prepare('UPDATE guarded_checks SET used_at = ? WHERE id = ? AND used_at IS NULL').run(usedAt, check.id)
  return { ok: true, check: { ...check, used_at: usedAt } }
}

/** How much of the goal's instructions a dry run returns as its job, for the model check (#170). */
export const GUARDED_JOB_CHARS = 1000

export type GuardedStage =
  | { ok: true; category: string; command: string; files: string[]; goal_name?: string; job?: string }
  | { ok: false; reason: string }

/**
 * guarded_run's server half (#159): checks a call for a marked run and, unless
 * `dryRun`, stages it. The command must map (as a Bash call) to a category the
 * goal keeps auto after outside content, and name the goal's own repo and a PR
 * or issue the run was started for (#168); then the payload rules run. On a pass,
 * each file is written under `<dataDir>/guarded/<run id>/`, every mention of its
 * original path in the command is pointed at the copy, and the check is recorded
 * (one use). It never runs the command: the run makes the returned call itself.
 * The plugin calls it twice, `dryRun` first, with its Haiku check in between:
 * the dry run also returns the goal's name and its job (the objective, then
 * the instructions clipped to GUARDED_JOB_CHARS), the person's own text, so the
 * check can judge whether the call does this goal's job (#170).
 */
export function stageGuardedCall(
  db: Database, runId: string, command: string, files: GuardedFile[],
  opts: { dataDir: string; env?: Record<string, string | undefined>; dryRun?: boolean; repo?: string | null },
): GuardedStage {
  const run = getRun(db, runId)
  if (!run || !['queued', 'running'].includes(run.status)) return { ok: false, reason: 'this run is not running' }
  const goal = getGoal(db, run.plan_id)
  if (!goal) return { ok: false, reason: 'the goal is gone' }
  const category = matchToolCategory(goal.tool_map, 'Bash', { command })
  if (!category || !goal.auto_after_outside.includes(category) || autonomyFor(goal, category) !== 'auto') {
    return { ok: false, reason: category ? `"${category}" isn't a category the goal keeps auto after outside content` : "the command doesn't match any of the goal's tool rules" }
  }
  const ownRepo = opts.repo !== undefined ? opts.repo : goalRepo((db.prepare('SELECT working_dir FROM plans WHERE id = ?').get(run.plan_id) as { working_dir: string | null } | undefined)?.working_dir ?? null)
  const targetRefusal = checkGuardedTarget(command, ownRepo, runTargets(db, runId))
  if (targetRefusal) return { ok: false, reason: targetRefusal }
  const check = checkGuardedPayload(command, files, opts.env ?? process.env, runSecretPaths(run).map(secretFileValues))
  if (!check.ok) return check
  // A run that read secrets loses the setting (#169)
  if (!afterOutsideApplies(run)) return { ok: false, reason: secretsReadReason(run, category) }
  if (opts.dryRun) {
    const instructions = goal.instructions.length > GUARDED_JOB_CHARS ? `${goal.instructions.slice(0, GUARDED_JOB_CHARS - 1)}…` : goal.instructions
    const job = [goal.objective, instructions].filter((t) => t.trim()).join('\n\n')
    return { ok: true, category, command, files: [], goal_name: getPlan(db, run.plan_id)?.name ?? run.plan_id, job }
  }
  const dir = join(opts.dataDir, 'guarded', runId)
  mkdirSync(dir, { recursive: true })
  const stamp = newId('gf')
  let staged = command
  const copies: GuardedFile[] = files.map((f, i) => {
    const path = join(dir, `${stamp}-${i}-${basename(f.path.replace(/\\/g, '/'))}`)
    writeFileSync(path, f.contents)
    staged = staged.split(f.path).join(path)
    return { path, contents: f.contents }
  })
  recordGuardedCheck(db, run, category, staged, copies)
  return { ok: true, category, command: staged, files: copies.map((c) => c.path) }
}

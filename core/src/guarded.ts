/**
 * The rule checks guarded_run makes before it stages a call for a goal run
 * that has read outside content (#159). They run before the Haiku check, so a
 * payload that fails here never reaches the model.
 */

import { createHash } from 'crypto'
import type { Database } from './sqlite.js'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterOutsideApplies, newId, getGoal, getRun, runSecretPaths, secretsReadReason } from './goals.js'
import { autonomyFor } from './goal-engine.js'
import { matchToolCategory } from './guard.js'

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

export type GuardedStage =
  | { ok: true; category: string; command: string; files: string[] }
  | { ok: false; reason: string }

/**
 * guarded_run's server half (#159): checks a call for a marked run and, unless
 * `dryRun`, stages it. The command must map (as a Bash call) to a category the
 * goal keeps auto after outside content; then the payload rules run. On a pass,
 * each file is written under `<dataDir>/guarded/<run id>/`, every mention of its
 * original path in the command is pointed at the copy, and the check is recorded
 * (one use). It never runs the command: the run makes the returned call itself.
 * The plugin calls it twice, `dryRun` first, with its Haiku check in between.
 */
export function stageGuardedCall(
  db: Database, runId: string, command: string, files: GuardedFile[],
  opts: { dataDir: string; env?: Record<string, string | undefined>; dryRun?: boolean },
): GuardedStage {
  const run = getRun(db, runId)
  if (!run || !['queued', 'running'].includes(run.status)) return { ok: false, reason: 'this run is not running' }
  const goal = getGoal(db, run.plan_id)
  if (!goal) return { ok: false, reason: 'the goal is gone' }
  const category = matchToolCategory(goal.tool_map, 'Bash', { command })
  if (!category || !goal.auto_after_outside.includes(category) || autonomyFor(goal, category) !== 'auto') {
    return { ok: false, reason: category ? `"${category}" isn't a category the goal keeps auto after outside content` : "the command doesn't match any of the goal's tool rules" }
  }
  const check = checkGuardedPayload(command, files, opts.env ?? process.env, runSecretPaths(run).map(secretFileValues))
  if (!check.ok) return check
  // A run that read secrets loses the setting (#169)
  if (!afterOutsideApplies(run)) return { ok: false, reason: secretsReadReason(run, category) }
  if (opts.dryRun) return { ok: true, category, command, files: [] }
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

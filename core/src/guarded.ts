/**
 * The rule checks guarded_run makes before it stages a call for a goal run
 * that has read outside content (#159). They run before the Haiku check, so a
 * payload that fails here never reaches the model.
 */

import { createHash } from 'crypto'
import type { Database } from './sqlite.js'
import { newId } from './goals.js'

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
  return { ok: true }
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

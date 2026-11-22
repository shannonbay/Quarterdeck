import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  openDatabase, createGoal, updateGoal, insertRun, addItem, guardToolCallForRun, SCHEMA_VERSION,
  stageProposalCalls, proposalCalls, proposalCallsWithFiles, buildOverview, proposalHasCalls, clearProposalCalls, proposalCallsProblem, PROPOSAL_MAX_CALLS, GUARDED_MAX_BYTES, proposalKey,
} from './index.js'

// #167: an approved proposal covers only the exact calls it staged, each once
describe('proposal staged calls (#167)', () => {
  let db: Database
  let dataDir: string
  const now = new Date().toISOString()
  const paths = { dirs: ['/nowhere/qd-data'], db: null }

  beforeEach(() => {
    db = openDatabase(':memory:')
    dataDir = mkdtempSync(join(tmpdir(), 'qd-proposal-'))
    createGoal(db, { id: 'g1', name: 'G', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now }, { objective: 'o', instructions: '', autonomy: { 'gh.review': 'propose' } })
    updateGoal(db, 'g1', { tool_map: { 'Bash(gh pr review*)': 'gh.review' } })
  })

  const approve = (id: string) => db.prepare("UPDATE tasks SET status = 'active', approved_at = ? WHERE id = ?").run(now, id)
  const propose = (runId: string, ref: string) => {
    const r = addItem(db, 'g1', runId, { goal: 'Review', external_ref: ref, action: { category: 'gh.review', summary: 'Post review' } })
    return r.task.id
  }
  const bash = (runId: string, command: string) => guardToolCallForRun(db, runId, 'Bash', { command }, paths)

  it('schema 29 adds guarded_checks.task_id', () => {
    expect(SCHEMA_VERSION).toBe(29)
    const cols = (db.prepare('PRAGMA table_info(guarded_checks)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('task_id')
  })

  it('stages files under guarded/<task id>/ and returns the staged commands', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(run.id, 'a')
    const [cmd] = stageProposalCalls(db, { id, plan_id: 'g1', run_id: run.id }, 'gh.review', [
      { command: 'gh pr review 12 --body-file /work/review.md', files: [{ path: '/work/review.md', contents: 'LGTM' }] },
    ], { dataDir })
    expect(cmd).toContain(join(dataDir, 'guarded', `g1-${id}`))
    expect(cmd).not.toContain('/work/review.md')
    expect(proposalHasCalls(db, proposalKey('g1', id))).toBe(true)
    expect(proposalCalls(db, proposalKey('g1', id))).toHaveLength(1)
  })

  it('once approved, the exact staged call goes through once, from a later run; anything else is refused with the reason', () => {
    const first = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(first.id, 'a')
    const [cmd] = stageProposalCalls(db, { id, plan_id: 'g1', run_id: first.id }, 'gh.review', [
      { command: 'gh pr review 12 --body-file /work/review.md', files: [{ path: '/work/review.md', contents: 'LGTM' }] },
    ], { dataDir })
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(first.id)
    approve(id)
    const later = insertRun(db, 'g1', 'manual', 'running')
    const other = bash(later.id, 'gh pr review 13 --approve')
    expect(other.decision).toBe('deny')
    expect(other.reason).toContain('no staged call')
    expect(bash(later.id, cmd).decision).toBe('allow')
    const again = bash(later.id, cmd)
    expect(again.decision).toBe('deny')
    expect(again.reason).toContain('already made')
  })

  it('lets an approved staged call through when its copies live under a .quarterdeck data dir, with the default data paths', () => {
    const qdDir = join(dataDir, '.quarterdeck')
    const run = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(run.id, 'a')
    const [cmd] = stageProposalCalls(db, { id, plan_id: 'g1', run_id: run.id }, 'gh.review', [
      { command: 'gh pr review 12 --body-file /work/review.md', files: [{ path: '/work/review.md', contents: 'LGTM' }] },
    ], { dataDir: qdDir })
    expect(cmd).toContain('.quarterdeck')
    approve(id)
    const decision = guardToolCallForRun(db, run.id, 'Bash', { command: cmd })
    expect(decision.decision).toBe('allow')
    expect(decision.category).toBe('gh.review')
    // Used once: the same call again is refused (as Quarterdeck's own data, now nothing covers it)
    expect(guardToolCallForRun(db, run.id, 'Bash', { command: cmd }).decision).toBe('deny')
  })

  it('still refuses an approved staged call that names the data folder beyond its staged copies', () => {
    const qdDir = join(dataDir, '.quarterdeck')
    const run = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(run.id, 'a')
    const [cmd] = stageProposalCalls(db, { id, plan_id: 'g1', run_id: run.id }, 'gh.review', [
      { command: `gh pr review 12 --body-file /work/review.md && cat ${join(qdDir, 'tasks.db')}`, files: [{ path: '/work/review.md', contents: 'LGTM' }] },
    ], { dataDir: qdDir })
    approve(id)
    const decision = guardToolCallForRun(db, run.id, 'Bash', { command: cmd })
    expect(decision.decision).toBe('deny')
    expect(decision.category).toBe('quarterdeck-data')
  })

  it("lets the PR Reviewer's staged review post through once approved, with the default data dir (#167 part 2)", () => {
    // The PR Reviewer template's rules (reviewRules in plugins/quarterdeck-goals/hooks/templates.ts)
    updateGoal(db, 'g1', { autonomy: { 'github.review': 'propose', 'github.write': 'off' }, tool_map: {
      'Bash(gh api repos/*/pulls/*/reviews*)': 'github.review',
      'PowerShell(gh api repos/*/pulls/*/reviews*)': 'github.review',
      'Bash(git push*)': 'github.write',
    } })
    const qdDir = join(dataDir, '.quarterdeck')
    const run = insertRun(db, 'g1', 'manual', 'running')
    const r = addItem(db, 'g1', run.id, { goal: 'Review #12', external_ref: 'github-pr-review:12@abc', action: { category: 'github.review', summary: 'Post review' } })
    const review = join(dataDir, 'review-12.json')
    const [cmd] = stageProposalCalls(db, { id: r.task.id, plan_id: 'g1', run_id: run.id }, 'github.review', [
      { command: `gh api repos/shannonbay/Quarterdeck/pulls/12/reviews --method POST --input ${review}`, files: [{ path: review, contents: '{"commit_id":"abc","event":"COMMENT","body":"LGTM","comments":[]}' }] },
    ], { dataDir: qdDir })
    approve(r.task.id)
    const decision = guardToolCallForRun(db, run.id, 'Bash', { command: cmd })
    expect(decision.decision).toBe('allow')
    expect(decision.category).toBe('github.review')
  })

  it('refuses a staged call whose file changed or is gone', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(run.id, 'a')
    const [a, b] = stageProposalCalls(db, { id, plan_id: 'g1', run_id: run.id }, 'gh.review', [
      { command: 'gh pr review 12 --body-file /w/a.md', files: [{ path: '/w/a.md', contents: 'one' }] },
      { command: 'gh pr review 14 --body-file /w/b.md', files: [{ path: '/w/b.md', contents: 'two' }] },
    ], { dataDir })
    approve(id)
    const [fa, fb] = proposalCalls(db, proposalKey('g1', id)).map((c) => c.files[0])
    writeFileSync(fa, 'changed')
    expect(bash(run.id, a).reason).toContain('changed after it was proposed')
    rmSync(fb)
    expect(bash(run.id, b).reason).toContain('is gone')
  })

  it('a proposal without calls still covers its whole category', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(run.id, 'a')
    approve(id)
    expect(proposalHasCalls(db, proposalKey('g1', id))).toBe(false)
    expect(bash(run.id, 'gh pr review 1 --approve').decision).toBe('allow')
    expect(bash(run.id, 'gh pr review 2 --approve').decision).toBe('allow')
  })

  it('restaging drops the old calls and their files', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(run.id, 'a')
    const [old] = stageProposalCalls(db, { id, plan_id: 'g1', run_id: run.id }, 'gh.review', [{ command: 'gh pr review 12 --approve' }], { dataDir })
    const [now2] = stageProposalCalls(db, { id, plan_id: 'g1', run_id: run.id }, 'gh.review', [{ command: 'gh pr review 12 --comment' }], { dataDir })
    approve(id)
    expect(bash(run.id, old).decision).toBe('deny')
    expect(bash(run.id, now2).decision).toBe('allow')
    clearProposalCalls(db, proposalKey('g1', id), dataDir)
    expect(proposalHasCalls(db, proposalKey('g1', id))).toBe(false)
    expect(existsSync(join(dataDir, 'guarded', `g1-${id}`))).toBe(false)
  })

  it('caps the number of calls and their size', () => {
    expect(proposalCallsProblem(Array.from({ length: PROPOSAL_MAX_CALLS + 1 }, () => ({ command: 'x' })))).toContain('at most')
    expect(proposalCallsProblem([{ command: ' ' }])).toContain('no command')
    expect(proposalCallsProblem([{ command: 'x', files: [{ path: 'p', contents: 'a'.repeat(GUARDED_MAX_BYTES) }] }])).toContain('limit')
    expect(proposalCallsProblem([{ command: 'gh pr review 1' }])).toBeNull()
  })

  // #167 part 2: the pane and the goal page show what approving lets through
  it("the overview shows a waiting proposal's staged calls, or that it covers any call in its category", () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const staged = propose(run.id, 'a')
    stageProposalCalls(db, { id: staged, plan_id: 'g1', run_id: run.id }, 'gh.review', [
      { command: 'gh pr review 12 --body-file /work/review.md', files: [{ path: '/work/review.md', contents: 'LGTM' }] },
    ], { dataDir })
    const wide = propose(run.id, 'b')
    const goal = buildOverview(db).goals.find((g) => g.id === 'g1')!
    const item = (id: string) => goal.needs_you.find((i) => i.id === id) as { action: { calls?: { command: string; files: string[] }[]; covers_any?: boolean } }
    expect(item(staged).action.calls).toHaveLength(1)
    expect(item(staged).action.calls![0]!.command).toContain(join(dataDir, 'guarded'))
    expect(item(staged).action.calls![0]!.files[0]).toContain('review.md')
    expect(item(staged).action.covers_any).toBeUndefined()
    expect(item(wide).action.covers_any).toBe(true)
    expect(item(wide).action.calls).toBeUndefined()
  })

  it('the goal page reads each staged file as it is now, null once it is gone', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const id = propose(run.id, 'a')
    stageProposalCalls(db, { id, plan_id: 'g1', run_id: run.id }, 'gh.review', [
      { command: 'gh pr review 12 --body-file /work/review.md', files: [{ path: '/work/review.md', contents: 'LGTM' }] },
    ], { dataDir })
    const [call] = proposalCallsWithFiles(db, proposalKey('g1', id))
    expect(call!.files[0]!.contents).toBe('LGTM')
    rmSync(call!.files[0]!.path)
    expect(proposalCallsWithFiles(db, proposalKey('g1', id))[0]!.files[0]!.contents).toBeNull()
  })
})

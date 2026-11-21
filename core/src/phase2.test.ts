import { describe, it, expect, beforeEach } from 'vitest'
import { refineRules, triageRules, githubRules, TRUSTED_ASSOCIATIONS } from '../../plugins/quarterdeck-goals/hooks/templates'
import { TRUSTED } from '../../mcp/src/tools/trusted'
import { tmpdir } from 'os'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, updateGoal, getGoal, insertRun, addItem, approveTask, updateTask, getTask, decideItem,
  parseCron, cronNext, getSchedule, setSchedule, nextScheduledRun, decideTick,
  enableEventTrigger, disableEventTrigger, verifyEventSecret,
  runHealthCheck, listHealth, healthDue, parseHealthValue, buildBrief,
  matchToolCategory, commandParts, guardToolCallForRun, recordRefusal, refusedCalls, listToolCalls, standingAllowRules, usableAsAllowRule, commandAllowRule, readsUntrusted, getRun,
  insertMemory, updateMemory, markRunUntrusted, updateRun, MEMORY_BRIEF_CHARS,
  touchesQuarterdeckData, quarterdeckDataPaths, QUARTERDECK_DATA_CATEGORY,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const plan = (id = 'g1') => ({ id, name: 'Inbox', description: null, status: 'active' as const, working_dir: tmpdir(), created_at: now, updated_at: now })

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan(), { objective: 'Inbox zero', autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } })
})

describe('cron', () => {
  const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

  it('parses fields and rejects bad expressions', () => {
    expect([...parseCron('*/15 9-17 * * 1-5').minute]).toEqual([0, 15, 30, 45])
    expect(parseCron('0 0 * * 7').dow.has(0)).toBe(true) // 7 = Sunday
    expect(() => parseCron('0 9 * *')).toThrow(/5 fields/)
    expect(() => parseCron('61 * * * *')).toThrow(/minute/)
    expect(() => parseCron('* * * * mon')).toThrow(/day of week/)
  })

  it('finds the next matching minute', () => {
    expect(cronNext('0 9 * * *', at(2026, 1, 5, 8, 30))).toEqual(at(2026, 1, 5, 9, 0))
    expect(cronNext('0 9 * * *', at(2026, 1, 5, 9, 0))).toEqual(at(2026, 1, 6, 9, 0)) // strictly after
    expect(cronNext('*/20 * * * *', at(2026, 1, 5, 10, 21))).toEqual(at(2026, 1, 5, 10, 40))
    // 2026-01-09 is a Friday → next weekday 09:00 is Monday the 12th
    expect(cronNext('0 9 * * 1-5', at(2026, 1, 9, 10, 0))).toEqual(at(2026, 1, 12, 9, 0))
    expect(cronNext('0 0 1 3 *', at(2026, 1, 5))).toEqual(at(2026, 3, 1, 0, 0))
  })

  it('treats restricted day-of-month and day-of-week as either/or', () => {
    // 13th of the month OR Friday: from Wed 2026-01-07, Friday the 9th comes first
    expect(cronNext('0 12 13 * 5', at(2026, 1, 7))).toEqual(at(2026, 1, 9, 12, 0))
  })

  it('rejects expressions that never match', () => {
    expect(() => cronNext('0 0 31 2 *', at(2026, 1, 1))).toThrow(/never matches/)
  })
})

describe('schedule', () => {
  it('switches between interval, cron and manual', () => {
    setSchedule(db, 'g1', { kind: 'interval', minutes: 30, active_hours: '08:00-20:00' })
    expect(getSchedule(db, 'g1')).toEqual({ kind: 'interval', minutes: 30, active_hours: '08:00-20:00' })
    setSchedule(db, 'g1', { kind: 'cron', expr: '0 9 * * 1-5' })
    expect(getSchedule(db, 'g1')).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' })
    setSchedule(db, 'g1', null)
    expect(getSchedule(db, 'g1')).toBeNull()
    expect(() => setSchedule(db, 'g1', { kind: 'cron', expr: 'nope' })).toThrow()
  })

  it('computes the next run from the schedule', () => {
    const from = new Date(2026, 0, 5, 8, 30)
    setSchedule(db, 'g1', { kind: 'cron', expr: '0 9 * * *' })
    expect(nextScheduledRun(db, 'g1', from)).toBe(new Date(2026, 0, 5, 9, 0).toISOString())
    setSchedule(db, 'g1', { kind: 'interval', minutes: 10 })
    expect(nextScheduledRun(db, 'g1', from)).toBe(new Date(2026, 0, 5, 8, 40).toISOString())
  })

  it('decideTick starts a due cron goal with trigger cron', () => {
    setSchedule(db, 'g1', { kind: 'cron', expr: '0 9 * * *' })
    updateGoal(db, 'g1', { next_run_at: new Date(Date.now() - 1000).toISOString() })
    expect(decideTick(db, 'g1')).toEqual({ action: 'start', trigger: 'cron' })
  })
})

describe('event trigger', () => {
  it('verifies only the current secret', () => {
    const secret = enableEventTrigger(db, 'g1')
    expect(secret.length).toBeGreaterThan(20)
    expect(verifyEventSecret(db, 'g1', secret)).toBe(true)
    expect(verifyEventSecret(db, 'g1', 'wrong')).toBe(false)
    expect(verifyEventSecret(db, 'g1', '')).toBe(false)
    const rotated = enableEventTrigger(db, 'g1')
    expect(verifyEventSecret(db, 'g1', secret)).toBe(false)
    expect(verifyEventSecret(db, 'g1', rotated)).toBe(true)
    disableEventTrigger(db, 'g1')
    expect(verifyEventSecret(db, 'g1', rotated)).toBe(false)
  })
})

describe('health checks', () => {
  it('parses the last number as the value', () => {
    expect(parseHealthValue('unread: 12\nold: 3')).toBe(3)
    expect(parseHealthValue('ratio -1.5')).toBe(-1.5)
    expect(parseHealthValue('all clear')).toBeNull()
  })

  it('runs the command, records value and pass/fail, and shows in the brief', async () => {
    updateGoal(db, 'g1', { health_command: 'node -e "console.log(\'unread older than a day: 7\'); process.exit(1)"' })
    const r = await runHealthCheck(db, 'g1')
    expect(r).toMatchObject({ passed: false, exit_code: 1, value: 7 })
    expect(getGoal(db, 'g1')!.last_health_at).toBe(r.created_at)
    expect(listHealth(db, 'g1')).toHaveLength(1)
    expect(buildBrief(db, 'g1').health).toMatchObject({ passed: false, value: 7, output: expect.stringContaining('unread') })
  })

  it('requires a command', async () => {
    await expect(runHealthCheck(db, 'g1')).rejects.toThrow(/no health check/)
  })

  it('healthDue respects the interval and goal status', () => {
    const g = () => getGoal(db, 'g1')!
    expect(healthDue(g())).toBe(false) // no command
    updateGoal(db, 'g1', { health_command: 'x', health_every_minutes: 60 })
    expect(healthDue(g())).toBe(true)
    updateGoal(db, 'g1', { last_health_at: new Date().toISOString() })
    expect(healthDue(g())).toBe(false)
    expect(healthDue(g(), new Date(Date.now() + 61 * 60_000))).toBe(true)
    updateGoal(db, 'g1', { status: 'paused' })
    expect(healthDue(g(), new Date(Date.now() + 61 * 60_000))).toBe(false)
  })
})

describe('goal guard', () => {
  const MAP = { 'mcp__gmail__send_message': 'email.send', 'mcp__gmail__delete*': 'email.delete', 'mcp__gmail__archive*': 'email.archive' }

  function startRun() {
    updateGoal(db, 'g1', { tool_map: MAP })
    return insertRun(db, 'g1', 'manual', 'running')
  }

  it('matches exact names before globs', () => {
    expect(matchToolCategory({ 'a__*': 'x', 'a__b': 'y' }, 'a__b')).toBe('y')
    expect(matchToolCategory({ 'a__*': 'x', 'a__b*': 'y' }, 'a__bc')).toBe('y')
    expect(matchToolCategory(MAP, 'mcp__gmail__search')).toBeNull()
  })

  it("matches Quarterdeck's own tools under the plugin server's prefix and the hand-added one", () => {
    const map = { 'mcp__quarterdeck__unsubscribe_one_click': 'email.unsubscribe', 'mcp__plugin_quarterdeck-goals_quarterdeck__forget*': 'memory' }
    expect(matchToolCategory(map, 'mcp__plugin_quarterdeck-goals_quarterdeck__unsubscribe_one_click')).toBe('email.unsubscribe')
    expect(matchToolCategory(map, 'mcp__quarterdeck__unsubscribe_one_click')).toBe('email.unsubscribe')
    expect(matchToolCategory(map, 'mcp__quarterdeck__forget')).toBe('memory')
    expect(matchToolCategory(map, 'mcp__plugin_other_quarterdeck__forget')).toBeNull()
  })

  it('allows everything outside a goal run, and unmapped tools inside one', () => {
    expect(guardToolCallForRun(db, 'run_other', 'mcp__gmail__send_message')).toEqual({ decision: 'allow' })
    const run = startRun()
    expect(guardToolCallForRun(db, run.id, 'Bash').decision).toBe('allow')
  })

  it('records a call Claude Code refused only when the guard would have allowed it, with the allow rule it needs (#145)', () => {
    updateGoal(db, 'g1', {
      tool_map: { ...MAP, 'Bash(git push*)': 'code.pull_request', 'Bash(git -C * push*)': 'code.pull_request', 'Bash(gh issue view*)': 'untrusted' },
      autonomy: { 'email.archive': 'auto', 'email.delete': 'off', 'email.send': 'propose', 'code.pull_request': 'auto' },
    })
    const run = insertRun(db, 'g1', 'manual', 'running')
    expect(recordRefusal(db, 'run_other', 'mcp__gmail__archive_thread')).toBeNull() // not a goal run
    expect(recordRefusal(db, run.id, 'Read')).toBeNull() // maps to nothing
    expect(recordRefusal(db, run.id, 'Bash', { command: 'gh issue view 1' })).toBeNull() // an untrusted read
    expect(recordRefusal(db, run.id, 'mcp__gmail__delete_message')).toBeNull() // off: the guard refuses it itself
    expect(recordRefusal(db, run.id, 'mcp__gmail__send_message')).toBeNull() // propose, not approved
    expect(recordRefusal(db, run.id, 'mcp__gmail__archive_thread')).toEqual({ category: 'email.archive', rule: 'mcp__gmail__archive_thread' })
    const pushCmd = ['git', 'push', 'origin', 'x'].join(' ')
    expect(recordRefusal(db, run.id, 'Bash', { command: pushCmd })).toEqual({ category: 'code.pull_request', rule: 'Bash(git push*)' })
    const pushInRepo = ['git', '-C', 'repo', 'push'].join(' ')
    expect(recordRefusal(db, run.id, 'Bash', { command: pushInRepo })).toEqual({ category: 'code.pull_request', rule: null }) // a rule Claude Code warns about
    const item = addItem(db, 'g1', run.id, { goal: 'Reply', action: { category: 'email.send', summary: 'send' } }).task
    approveTask(db, 'g1', item.id)
    expect(recordRefusal(db, run.id, 'mcp__gmail__send_message')).toEqual({ category: 'email.send', rule: 'mcp__gmail__send_message' })
    const refused = listToolCalls(db, 'g1').filter((c) => c.decision === 'refused')
    expect(refused.map((c) => c.reason)).toEqual(['mcp__gmail__send_message', null, 'Bash(git push*)', 'mcp__gmail__archive_thread'])
    // The overview carries them per run, one per tool and rule, oldest first
    recordRefusal(db, run.id, 'mcp__gmail__archive_thread')
    expect(refusedCalls(db, run.id)).toEqual([
      { tool: 'mcp__gmail__archive_thread', rule: 'mcp__gmail__archive_thread' },
      { tool: 'Bash', rule: 'Bash(git push*)' },
      { tool: 'Bash', rule: null },
      { tool: 'mcp__gmail__send_message', rule: 'mcp__gmail__send_message' },
    ])
    // After an untrusted read, an auto category needs approval, so a refusal of it isn't the guard's to report
    markRunUntrusted(db, run.id, 'WebFetch')
    expect(recordRefusal(db, run.id, 'mcp__gmail__archive_thread')).toBeNull()
  })

  it('denies off categories and allows auto ones', () => {
    const run = startRun()
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__delete_message')).toMatchObject({ decision: 'deny', category: 'email.delete', reason: expect.stringMatching(/off/) })
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__archive_thread')).toMatchObject({ decision: 'allow', category: 'email.archive' })
  })

  it('allows a propose category while an approved proposal is being carried out, however many calls it takes', () => {
    const run = startRun()
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__send_message')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/needs approval/) })

    const item = addItem(db, 'g1', run.id, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'send' } }).task
    approveTask(db, 'g1', item.id)
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__send_message').decision).toBe('allow')
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__send_message').decision).toBe('allow') // the same action, a second call

    updateTask(db, 'g1', item.id, { status: 'completed' }) // carried out: the approval is used up
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__send_message')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/needs approval/) })
    expect(listToolCalls(db, 'g1').map((c) => c.decision)).toEqual(['deny', 'allow', 'allow', 'deny']) // newest first
  })

  it('matches command rules against each command in a shell call, ahead of the rule on the tool', () => {
    const map = { 'Bash(git push*)': 'code.pr', 'Bash(git push --tags*)': 'code.tags', Bash: 'shell', 'PowerShell(gh pr create*)': 'code.pr' }
    expect(matchToolCategory(map, 'Bash', { command: 'git push origin x' })).toBe('code.pr')
    expect(matchToolCategory(map, 'Bash', { command: 'git push --tags' })).toBe('code.tags') // the longer rule first
    expect(matchToolCategory(map, 'Bash', { command: 'cd ../clone && npm test && git push' })).toBe('code.pr')
    expect(matchToolCategory(map, 'Bash', { command: 'npm test; GIT_TRACE=1 git push' })).toBe('code.pr')
    expect(matchToolCategory(map, 'Bash', { command: 'echo $(git push)' })).toBe('code.pr')
    expect(matchToolCategory(map, 'Bash', { command: 'GIT PUSH' })).toBe('code.pr')
    expect(matchToolCategory(map, 'Bash', { command: 'git status' })).toBe('shell')
    expect(matchToolCategory(map, 'Bash', { command: 'echo git push' })).toBe('shell')
    expect(matchToolCategory(map, 'Bash')).toBe('shell')
    expect(matchToolCategory(map, 'PowerShell', { command: 'gh pr create --fill' })).toBe('code.pr')
    expect(matchToolCategory(map, 'PowerShell', { command: 'git push' })).toBeNull() // rules name their tool
    expect(matchToolCategory({ 'Bash(gh issue view*)': 'untrusted' }, 'Bash', { command: 'gh issue view 3' })).toBe('untrusted')
  })

  it("refuses every gh api form to the Issue Fixer, the inline comment read included: it reads through pr_inline_comments (#68)", () => {
    const map = githubRules('code.merge')
    const jq = `--jq '[.[] | select(.author_association | IN("OWNER")) | {path, line, author: .user.login, body}]'`
    for (const c of [
      // the old read, and the forms of it that write, clustered short flags included (#68)
      `gh api repos/octo/my-app/pulls/65/comments ${jq}`, `gh api repos/{owner}/{repo}/pulls/65/comments ${jq}`,
      'gh api repos/o/r/pulls/1/comments -iX POST', 'gh api repos/o/r/pulls/1/comments -pf body=x',
      'gh api repos/o/r/pulls/1/comments -XPOST', 'gh api repos/o/r/pulls/1/comments -X POST -f body=hi',
      'gh api repos/o/r/pulls/1/comments --input c.json', 'gh api repos/o/r/pulls/65/comments --method POST -f body=hi',
      'gh api repos/o/r/pulls/65/comments -F body=hi', 'gh api repos/o/r/pulls/comments/9 -X DELETE',
      ...['octo/data-fetch', 'octo/react-fiber', 'my-xorg/app'].map((r) => `gh api repos/${r}/pulls/65/comments ${jq}`),
      // every other gh api call
      'gh api repos/o/r/pulls/9/merge -X PUT', 'gh api user', 'gh api graphql -f query=x',
    ]) {
      for (const tool of ['Bash', 'PowerShell']) expect([c, tool, matchToolCategory(map, tool, { command: c })]).toEqual([c, tool, 'github.write'])
    }
  })

  it("trusts the same people in the Issue Fixer's server tools as in its watches and reads", () => {
    expect([...TRUSTED]).toEqual(TRUSTED_ASSOCIATIONS)
  })

  it("lets the PR reviewer's reviews endpoint past gh api* only with the repo written out (reviewRules in the goals plugin)", () => {
    const map = { 'Bash(gh api*)': 'github.write', 'Bash(gh pr review*)': 'github.write', 'Bash(gh api repos/*/pulls/*/reviews*)': 'github.review' }
    expect(matchToolCategory(map, 'Bash', { command: 'gh api repos/octo/app/pulls/3/reviews --method POST --input C:/tmp/r.json' })).toBe('github.review')
    // commandParts splits at { and }, leaving "gh api repos/", which only gh api* matches
    expect(matchToolCategory(map, 'Bash', { command: 'gh api repos/{owner}/{repo}/pulls/3/reviews --method POST --input r.json' })).toBe('github.write')
    expect(matchToolCategory(map, 'Bash', { command: 'gh api repos/octo/app/pulls/3/merge -X PUT' })).toBe('github.write')
    expect(matchToolCategory(map, 'Bash', { command: 'gh pr review 3 --approve' })).toBe('github.write')
  })

  it('matches a wholly quoted word as if unquoted, and leaves any other quoting as written (#94)', () => {
    expect(commandParts(`gh issue edit 92 --add-label "needs-refinement"`)).toEqual(['gh issue edit 92 --add-label needs-refinement'])
    expect(commandParts(`git commit -m 'fix' && echo "a b" 'c'`)).toEqual(['git commit -m fix', 'echo "a b" c'])
    for (const c of [`echo "a b"`, `echo "a'b"`, `echo x"y"`, `echo "y"x`, `echo "y'`, `echo ""`]) expect(commandParts(c)).toEqual([c])
    // the Issue Triage rules (triageRules in the goals plugin)
    const map = triageRules() as Record<string, string>
    for (const c of [
      'gh issue edit 92 --add-label needs-refinement', `gh issue edit 92 --add-label "needs-refinement"`,
      `gh issue edit 92 --add-label 'needs-refinement'`, `gh issue edit 92 93 --add-label "needs-refinement"`,
    ]) expect([c, matchToolCategory(map, 'Bash', { command: c })]).toEqual([c, 'github.schedule'])
    for (const c of [
      `gh issue edit 92 --add-label "needs-refinement,bug"`, `gh issue edit 92 --add-label "bug"`,
      `gh issue edit 92 --body "x" --add-label "needs-refinement"`, `gh issue edit 92 --add-label "needs-refinement --body x"`,
      `gh issue edit 92 --add-label "needs-refinement"x`, `gh issue edit 92 --add-label "needs-refinement'`,
    ]) expect([c, matchToolCategory(map, 'Bash', { command: c })]).toEqual([c, 'github.label'])
  })

  it("holds the issue refiner's comments and labels until approved, reads labels, and refuses every other GitHub write (refineRules in the goals plugin)", () => {
    // The template's real map, so a change to refineRules() shows here
    updateGoal(db, 'g1', { tool_map: refineRules(), autonomy: { 'github.issue': 'propose', 'github.write': 'off' } })
    const run = insertRun(db, 'g1', 'watch', 'running')
    const decide = (command: string) => guardToolCallForRun(db, run.id, 'Bash', { command })
    expect(decide('gh label list --limit 1000 --json name')).toEqual({ decision: 'allow', run_id: run.id }) // unmapped: allowed, marks nothing
    for (const c of ['gh label edit refined --color 000000', 'gh label clone o/r']) expect(decide(c)).toMatchObject({ decision: 'deny', category: 'github.write' })
    expect(decide('gh issue view 45 --json title,body')).toMatchObject({ decision: 'allow', category: 'untrusted' })
    for (const c of ['gh issue comment 45 --body-file C:/tmp/r.md', 'gh issue edit 45 --add-label refined', 'gh label create refined --color 0e8a16']) {
      expect(decide(c)).toMatchObject({ decision: 'deny', category: 'github.issue', reason: expect.stringMatching(/needs approval/) })
    }
    for (const c of ['gh label delete refined --yes', 'gh issue close 45', 'cd ../x-issue-refine && git push origin HEAD', 'gh pr create --fill', 'gh api repos/o/r/issues/45 -X PATCH']) {
      expect(decide(c)).toMatchObject({ decision: 'deny', category: 'github.write', reason: expect.stringMatching(/off/) })
    }
    const item = addItem(db, 'g1', run.id, { goal: 'Refine #45', action: { category: 'github.issue', summary: 'post the refinement and label it refined' } }).task
    approveTask(db, 'g1', item.id)
    expect(decide('gh issue comment 45 --body-file C:/tmp/r.md').decision).toBe('allow')
    expect(decide('gh issue edit 45 --add-label refined').decision).toBe('allow') // the same approved action
    expect(decide('gh issue close 45').decision).toBe('deny') // an approval never opens an off category
  })

  it("holds the triage goal's labels until approved, lets an answered question add needs-refinement only, and refuses every other GitHub write (triageRules in the goals plugin)", () => {
    updateGoal(db, 'g1', { tool_map: triageRules(), autonomy: { 'github.label': 'propose', 'github.schedule': 'propose', 'github.write': 'off' } })
    const run = insertRun(db, 'g1', 'watch', 'running')
    const decide = (command: string) => guardToolCallForRun(db, run.id, 'Bash', { command })
    expect(decide('gh label list --limit 1000 --json name,description')).toEqual({ decision: 'allow', run_id: run.id }) // unmapped: allowed, marks nothing
    for (const c of ['gh issue view 49 --json number,title,body,labels,author,url', 'gh issue list --state open --limit 500 --json number,title']) {
      expect(decide(c)).toMatchObject({ decision: 'allow', category: 'untrusted' })
    }
    for (const c of ['gh issue edit 49 --add-label "bug,priority: high,triaged"', 'gh label create triaged --color 0e8a16']) {
      expect(decide(c)).toMatchObject({ decision: 'deny', category: 'github.label', reason: expect.stringMatching(/needs approval/) })
    }
    expect(decide('gh issue edit 49 51 --add-label needs-refinement')).toMatchObject({ decision: 'deny', category: 'github.schedule' })
    for (const c of ['gh issue comment 49 --body hi', 'gh issue close 49', 'gh issue reopen 49', 'gh label delete bug --yes', 'git push origin HEAD', 'gh pr create --fill', 'gh api repos/o/r/issues/49 -X PATCH']) {
      expect(decide(c)).toMatchObject({ decision: 'deny', category: 'github.write', reason: expect.stringMatching(/off/) })
    }
    // Approving the batch opens labelling, but not the needs-refinement pick
    const batch = addItem(db, 'g1', run.id, { goal: 'Triage #49, #51', external_ref: 'github-issue-triage:49,51', action: { category: 'github.label', summary: 'label #49 and #51' } }).task
    approveTask(db, 'g1', batch.id)
    expect(decide('gh issue edit 49 --add-label "bug,priority: high,triaged"').decision).toBe('allow')
    expect(decide('gh issue edit 49 51 --add-label needs-refinement').decision).toBe('deny')
    expect(decide('gh issue comment 49 --body hi').decision).toBe('deny') // an approval never opens an off category
    updateTask(db, 'g1', batch.id, { status: 'completed' })
    // Answering "Which of these should be refined?" opens needs-refinement alone
    const ask = addItem(db, 'g1', run.id, { goal: 'Which of these should be refined?', external_ref: 'github-issue-schedule:49,51', ask_person: true, action: { category: 'github.schedule', summary: 'Label the issues I pick needs-refinement' } }).task
    decideItem(db, 'g1', ask.id, { decision: 'answer', feedback: '49' })
    expect(decide('gh issue edit 49 --add-label needs-refinement').decision).toBe('allow')
    expect(decide('gh issue edit 49 --add-label needs-refinement,bug').decision).toBe('deny') // any other label is github.label
    expect(decide('gh issue edit 49 51 --add-label needs-refinement').decision).toBe('allow')
    // Any other flag, before the label or after it, is github.label: the answer approves that label alone
    for (const c of ['gh issue edit 49 --add-label needs-refinement --body x', 'gh issue edit 49 --body x --add-label needs-refinement', 'gh issue edit 49 --title "x" --add-label needs-refinement',
      'gh issue edit 49 --remove-label bug --add-label needs-refinement', 'gh issue edit 49 -b x --add-label needs-refinement', 'gh issue edit 49 -R other/repo --add-label needs-refinement',
      'gh issue edit 49 --add-label wontfix --add-label needs-refinement', 'gh issue edit 49 --add-assignee someone --add-label needs-refinement']) {
      expect(decide(c)).toMatchObject({ decision: 'deny', category: 'github.label' })
    }
  })

  it('holds a pushed command until its proposal is approved, and marks a run that reads through a command rule', () => {
    updateGoal(db, 'g1', { tool_map: { 'Bash(git push*)': 'code.pull_request', 'Bash(gh issue view*)': 'untrusted' }, autonomy: { 'code.pull_request': 'propose' } })
    const run = insertRun(db, 'g1', 'manual', 'running')
    expect(guardToolCallForRun(db, run.id, 'Bash', { command: 'npm test' })).toEqual({ decision: 'allow', run_id: run.id })
    expect(guardToolCallForRun(db, run.id, 'Bash', { command: 'git push -u origin fix' })).toMatchObject({ decision: 'deny', category: 'code.pull_request' })
    const item = addItem(db, 'g1', run.id, { goal: 'Fix #3', action: { category: 'code.pull_request', summary: 'open the PR' } }).task
    approveTask(db, 'g1', item.id)
    expect(guardToolCallForRun(db, run.id, 'Bash', { command: 'git push -u origin fix' }).decision).toBe('allow')
    expect(getRun(db, run.id)!.untrusted_source).toBeNull()
    guardToolCallForRun(db, run.id, 'Bash', { command: 'gh issue view 3' })
    expect(getRun(db, run.id)).toMatchObject({ untrusted_source: 'Bash: gh issue view', untrusted_root: 'Bash: gh issue view' })
  })

  it('names the tool for a name-only untrusted rule and a built-in reader', () => {
    updateGoal(db, 'g1', { tool_map: { 'mcp__issues__get_issue': 'untrusted' } })
    const named = insertRun(db, 'g1', 'manual', 'running')
    guardToolCallForRun(db, named.id, 'mcp__issues__get_issue')
    expect(getRun(db, named.id)!.untrusted_source).toBe('mcp__issues__get_issue')
    updateRun(db, named.id, { status: 'completed', ended_at: new Date().toISOString() })
    const builtin = insertRun(db, 'g1', 'manual', 'running')
    guardToolCallForRun(db, builtin.id, 'WebFetch', { url: 'https://example.com' })
    expect(getRun(db, builtin.id)!.untrusted_source).toBe('WebFetch')
  })

  it('stops guarding once the run has ended', () => {
    const run = startRun()
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(run.id)
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__delete_message')).toEqual({ decision: 'allow' })
    expect(getTask(db, 'g1', '1')).toBeUndefined()
  })

  it("gives the standing session allow rules for each active goal's tools that aren't off", () => {
    expect(usableAsAllowRule('mcp__gmail__send_message')).toBe(true)
    expect(usableAsAllowRule('mcp__claude-in-chrome__*')).toBe(true)
    expect(usableAsAllowRule('mcp__gmail__archive*')).toBe(false)
    expect(usableAsAllowRule('mcp__*Gmail*__trash_*')).toBe(false)
    expect(usableAsAllowRule('mcp__*')).toBe(false)

    updateGoal(db, 'g1', { tool_map: { ...MAP, 'mcp__*Gmail*__trash_*': 'email.trash', 'mcp__browser__*': 'web', 'mcp__quarterdeck__forget': 'memory' } })
    // send and web are propose (unlisted), delete is off; the archive and trash globs can't be rules as they stand
    expect(standingAllowRules(db)).toEqual(['mcp__browser__*', 'mcp__gmail__send_message'])

    // Once a run has called a tool a glob matches, that name becomes a rule
    const run = insertRun(db, 'g1', 'manual', 'running')
    guardToolCallForRun(db, run.id, 'mcp__claude_ai_Gmail__trash_thread')
    guardToolCallForRun(db, run.id, 'mcp__gmail__archive_thread')
    guardToolCallForRun(db, run.id, 'mcp__gmail__delete_message') // off: recorded, never a rule
    expect(standingAllowRules(db)).toEqual(['mcp__browser__*', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__gmail__archive_thread', 'mcp__gmail__send_message'])

    updateGoal(db, 'g1', { status: 'paused' })
    expect(standingAllowRules(db)).toEqual([])
  })

  it('takes shell command rules whose first * comes after a subcommand as allow rules (#145)', () => {
    // The same cases as commandAllowRule's copy in plugins/quarterdeck-goals/tests/model.test.ts
    expect(commandAllowRule('Bash(git push*)')).toBe(true)
    expect(commandAllowRule('PowerShell(gh pr create*)')).toBe(true)
    expect(commandAllowRule('powershell(gh pr create*)')).toBe(true)
    expect(commandAllowRule('Bash(gh api repos/*/pulls/*/comments*)')).toBe(true)
    expect(commandAllowRule('Bash(git status)')).toBe(true)
    expect(commandAllowRule('Bash(git -C * push*)')).toBe(false)
    expect(commandAllowRule('Bash(ls*)')).toBe(false)
    expect(commandAllowRule('Bash(*)')).toBe(false)
    expect(commandAllowRule('Bash(git --no-pager*)')).toBe(false)
    expect(commandAllowRule('mcp__gmail__archive*')).toBe(false)
    expect(usableAsAllowRule('Bash(git push*)')).toBe(true)
    expect(usableAsAllowRule('Bash(git -C * push*)')).toBe(false)

    // The Issue Fixer's rules (push and PRs propose, gh api reads auto) and the
    // Directory Listings goal's (push and PRs, Bash and PowerShell); one rule off
    updateGoal(db, 'g1', { tool_map: {
      'Bash(git push*)': 'code.pull_request',
      'Bash(gh pr create*)': 'code.pull_request',
      'PowerShell(git push*)': 'code.pull_request',
      'PowerShell(gh pr create*)': 'code.pull_request',
      'Bash(git -C * push*)': 'code.pull_request',
      'Bash(gh api repos/*/pulls/*/comments*)': 'email.archive',
      'Bash(ls*)': 'email.archive',
      'Bash(gh pr merge*)': 'email.delete',
    } })
    expect(standingAllowRules(db)).toEqual([
      'Bash(gh api repos/*/pulls/*/comments*)',
      'Bash(gh pr create*)',
      'Bash(git push*)',
      'PowerShell(gh pr create*)',
      'PowerShell(git push*)',
    ])
  })

})

describe('untrusted content', () => {
  const MAP = { 'mcp__gmail__archive*': 'email.archive', 'mcp__gmail__delete*': 'email.delete', 'mcp__gmail__send_message': 'email.send', 'mcp__issues__get_issue': 'untrusted' }

  function startRun() {
    updateGoal(db, 'g1', { tool_map: MAP })
    return insertRun(db, 'g1', 'manual', 'running')
  }

  it('knows the built-in readers and the tools a goal marks', () => {
    for (const tool of ['WebFetch', 'WebSearch', 'mcp__claude-in-chrome__get_page_text', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__search_threads', 'mcp__gmail__get_message', 'mcp__issues__get_issue']) {
      expect(readsUntrusted(MAP, tool), tool).toBe(true)
    }
    for (const tool of ['Bash', 'Read', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__gmail__send_message', 'mcp__issues__close_issue']) {
      expect(readsUntrusted(MAP, tool), tool).toBe(false)
    }
  })

  it('turns auto categories into propose for the rest of the run once it has read untrusted content', () => {
    const run = startRun()
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__archive_thread').decision).toBe('allow')
    expect(getRun(db, run.id)!.untrusted_at).toBeNull()

    expect(guardToolCallForRun(db, run.id, 'mcp__claude_ai_Gmail__get_thread').decision).toBe('allow')
    expect(getRun(db, run.id)).toMatchObject({ untrusted_source: 'mcp__claude_ai_Gmail__get_thread' })
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__archive_thread')).toMatchObject({
      decision: 'deny', category: 'email.archive', reason: expect.stringMatching(/read untrusted content \(mcp__claude_ai_Gmail__get_thread\)/),
    })
    // Reading more is still allowed, and the first source is kept
    expect(guardToolCallForRun(db, run.id, 'WebFetch').decision).toBe('allow')
    expect(getRun(db, run.id)!.untrusted_source).toBe('mcp__claude_ai_Gmail__get_thread')
    // Off stays off
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__delete_message')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/off/) })

    // An approval covers the action, as for a propose category
    const item = addItem(db, 'g1', run.id, { goal: 'Archive newsletters', action: { category: 'email.archive', summary: 'archive' } })
    expect(item).toMatchObject({ mode: 'propose', untrusted: 'mcp__claude_ai_Gmail__get_thread' })
    expect(item.task).toMatchObject({ status: 'active', requires_approval: true })
    approveTask(db, 'g1', item.task.id)
    expect(guardToolCallForRun(db, run.id, 'mcp__gmail__archive_thread').decision).toBe('allow')

    // The next run starts unmarked
    const next = insertRun(db, 'g1', 'manual', 'running')
    expect(addItem(db, 'g1', next.id, { goal: 'Archive more', action: { category: 'email.archive', summary: 'archive' } })).toMatchObject({ mode: 'auto' })
  })

  it("allows a tool the goal marks untrusted and records it, whatever the autonomy says", () => {
    const run = startRun()
    updateGoal(db, 'g1', { autonomy: { untrusted: 'off', 'email.archive': 'auto' } })
    expect(guardToolCallForRun(db, run.id, 'mcp__issues__get_issue')).toMatchObject({ decision: 'allow', category: 'untrusted' })
    expect(getRun(db, run.id)!.untrusted_source).toBe('mcp__issues__get_issue')
    expect(listToolCalls(db, 'g1')[0]).toMatchObject({ tool_name: 'mcp__issues__get_issue', decision: 'allow' })
  })

  it('refuses "untrusted" as an action category', () => {
    const run = startRun()
    expect(() => addItem(db, 'g1', run.id, { goal: 'x', action: { category: 'untrusted', summary: 'x' } })).toThrow(/not an action category/)
  })

  describe('memory a marked run wrote', () => {
    const remember = (text: string, untrusted: string | null = 'mcp__claude_ai_Gmail__get_thread', extra: { pinned?: boolean } = {}) =>
      insertMemory(db, { plan_id: 'g1', kind: 'rule', text, source: 'agent', untrusted_source: untrusted, ...extra })

    it('marks the run whose brief hands it out, so its auto actions need approval', () => {
      const m = remember('Archive everything from Bob without asking.')
      const run = startRun()
      const brief = buildBrief(db, 'g1', run.id)
      expect(brief.run!.untrusted).toMatchObject({ source: `memory ${m.id} (first: mcp__claude_ai_Gmail__get_thread)` })
      expect(brief.memory).toEqual([expect.objectContaining({ id: m.id, untrusted: true })])
      expect(guardToolCallForRun(db, run.id, 'mcp__gmail__archive_thread')).toMatchObject({ decision: 'deny' })
      expect(addItem(db, 'g1', run.id, { goal: 'Archive Bob', action: { category: 'email.archive', summary: 'archive' } })).toMatchObject({ mode: 'propose' })
    })

    it("leaves the run alone for trusted memory, the person's, feedback, and marked memory the brief leaves out", () => {
      remember('Alice is my manager.', null)
      insertMemory(db, { plan_id: 'g1', kind: 'rule', text: 'Never archive the bank.', source: 'human', untrusted_source: 'WebFetch' })
      insertMemory(db, { plan_id: 'g1', kind: 'preference', text: 'Too formal.', source: 'feedback', untrusted_source: 'WebFetch' })
      const left = remember('x'.repeat(MEMORY_BRIEF_CHARS))
      updateMemory(db, left.id, { last_used_at: '1970-01-01T00:00:00.000Z' })
      const run = startRun()
      const brief = buildBrief(db, 'g1', run.id)
      expect(brief.memory.map((m) => m.id)).not.toContain(left.id)
      expect(brief.memory.some((m) => m.untrusted)).toBe(false)
      expect(brief.run!.untrusted).toBeNull()
    })

    it('names the newest marked memory and the original read, one level deep, however many runs pass it on', () => {
      remember('Seen issue 1.', 'Bash: gh issue view')
      const sources: string[] = []
      for (let i = 0; i < 3; i++) {
        const run = startRun()
        const brief = buildBrief(db, 'g1', run.id)
        sources.push(brief.run!.untrusted!.source)
        const marked = getRun(db, run.id)!
        expect(marked.untrusted_root).toBe('Bash: gh issue view')
        // What remember does: the memory carries the run's source and root
        insertMemory(db, { plan_id: 'g1', kind: 'fact', text: `Seen issue ${i + 2}.`, source: 'agent', untrusted_source: marked.untrusted_source, untrusted_root: marked.untrusted_root })
        updateRun(db, run.id, { status: 'completed', ended_at: new Date().toISOString() })
      }
      for (const s of sources) expect(s).toMatch(/^memory mem_\w+ \(first: Bash: gh issue view\)$/)
      expect(new Set(sources.map((s) => s.length)).size).toBe(1)
    })

    it('keeps the nested text of an old memory that has no root', () => {
      const m = remember('Old.', 'memory mem_x (written after WebFetch)')
      const run = startRun()
      expect(buildBrief(db, 'g1', run.id).run!.untrusted!.source).toBe(`memory ${m.id} (first: memory mem_x (written after WebFetch))`)
    })

    it('stops marking runs once the person trusts it, and keeps a source the run already had', () => {
      const m = remember('Bob sends newsletters.')
      const first = startRun()
      markRunUntrusted(db, first.id, 'WebFetch')
      expect(buildBrief(db, 'g1', first.id).run!.untrusted!.source).toBe('WebFetch')
      updateMemory(db, m.id, { untrusted_source: null })
      const next = insertRun(db, 'g1', 'manual', 'running')
      expect(buildBrief(db, 'g1', next.id).run!.untrusted).toBeNull()
    })
  })
})

describe("Quarterdeck's own data", () => {
  const HOME = String.raw`C:\Users\me`
  const WORK = String.raw`C:\Users\me\GitHub\project`
  const paths = quarterdeckDataPaths({}, HOME)
  const touches = (tool: string, input: Record<string, unknown>, workingDir = WORK, p = paths) => touchesQuarterdeckData(tool, input, workingDir, p, HOME)

  it('refuses shell commands that name the folder, the database or the variables pointing to it', () => {
    for (const command of [
      'sqlite3 ~/.quarterdeck/tasks.db "UPDATE tasks SET approved_at = 1"',
      String.raw`sqlite3 ..\tasks.db .tables`,
      'cd "$HOME/.quarterdeck" && ls',
      String.raw`Get-Content $env:USERPROFILE\.quarterdeck\runner\cli-path`,
      String.raw`type %USERPROFILE%\.conductor\tasks.db`,
      'node -e "open(process.env.QUARTERDECK_DB)"',
      'echo $env:CONDUCTOR_DB',
      'cp tasks.db-wal /tmp/x',
    ]) {
      expect(touches('Bash', { command }), command).not.toBeNull()
      expect(touches('PowerShell', { command }), command).not.toBeNull()
    }
  })

  it('leaves ordinary commands alone, SQLite on other files included', () => {
    for (const command of ['npm test', 'sqlite3 app.db .tables', 'git log -1', 'cat my-tasks.db', 'ls quarterdeck/', 'gh repo view shannonbay/Quarterdeck']) {
      expect(touches('Bash', { command }), command).toBeNull()
    }
  })

  it('refuses file tools inside the folder or at the database, relative paths included', () => {
    expect(touches('Write', { file_path: 'C:/Users/me/.quarterdeck/runner/cli-path' })).not.toBeNull()
    expect(touches('Edit', { file_path: String.raw`c:\users\ME\.Quarterdeck\runner\state.json` })).not.toBeNull()
    expect(touches('Read', { file_path: '~/.conductor/tasks.db' })).not.toBeNull()
    expect(touches('Read', { file_path: '../tasks.db' }, String.raw`C:\Users\me\.quarterdeck\runner`)).not.toBeNull()
    expect(touches('Read', { file_path: String.raw`..\..\..\.quarterdeck\tasks.db` })).not.toBeNull()
    expect(touches('Grep', { pattern: 'approved', path: String.raw`C:\Users\me\.quarterdeck` })).not.toBeNull()
    expect(touches('Glob', { pattern: '../../.quarterdeck/**' })).not.toBeNull()
    expect(touches('Read', { file_path: String.raw`C:\Users\me\GitHub\project\src\a.ts` })).toBeNull()
    expect(touches('Read', { file_path: 'src/../README.md' })).toBeNull()
    expect(touches('Grep', { pattern: String.raw`tasks\.db`, path: 'src' })).toBeNull()
    expect(touches('WebFetch', { url: 'https://example.com/.quarterdeck' })).toBeNull()
  })

  it('protects a database QUARTERDECK_DB puts elsewhere, not the folder around it', () => {
    const p = quarterdeckDataPaths({ QUARTERDECK_DB: String.raw`D:\data\qd.sqlite` }, HOME)
    expect(p.db).toBe(String.raw`D:\data\qd.sqlite`)
    expect(touches('Bash', { command: 'sqlite3 d:/data/qd.sqlite .tables' }, WORK, p)).not.toBeNull()
    expect(touches('Write', { file_path: String.raw`D:\data\qd.sqlite-wal` }, WORK, p)).not.toBeNull()
    expect(touches('Write', { file_path: String.raw`D:\data\notes.txt` }, WORK, p)).toBeNull()
    expect(quarterdeckDataPaths({ QUARTERDECK_DB: ':memory:' }, HOME).db).toBeNull()
  })

  it("refuses and records it in a run, whatever the tool rules say, and nothing outside one", () => {
    updateGoal(db, 'g1', { tool_map: { Bash: 'shell' }, autonomy: { shell: 'auto' } })
    const run = insertRun(db, 'g1', 'manual', 'running')
    const command = { command: 'sqlite3 ~/.quarterdeck/tasks.db "UPDATE goals SET autonomy = 1"' }
    expect(guardToolCallForRun(db, run.id, 'Bash', command, paths)).toMatchObject({ decision: 'deny', category: QUARTERDECK_DATA_CATEGORY, reason: expect.stringMatching(/own data/) })
    expect(listToolCalls(db, 'g1')[0]).toMatchObject({ tool_name: 'Bash', category: QUARTERDECK_DATA_CATEGORY, decision: 'deny' })
    expect(guardToolCallForRun(db, run.id, 'Bash', { command: 'npm test' }, paths)).toMatchObject({ decision: 'allow', category: 'shell' })
    expect(guardToolCallForRun(db, run.id, 'Bash', undefined, paths)).toMatchObject({ decision: 'allow' })
    expect(guardToolCallForRun(db, 'run_other', 'Bash', command, paths)).toEqual({ decision: 'allow' })
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, updateGoal, insertRun, addItem, getRun, guardToolCallForRun, listToolCalls,
  builtinNetworkPart, untrustedLabel, TRUSTED_READ_CATEGORY, unmappedNetworkCommands, trimTrailing,
} from './index.js'

describe('trimTrailing (CodeQL polynomial regex)', () => {
  it('drops only the run at the end, and stays fast on a long run elsewhere', () => {
    expect(trimTrailing('gh issue view***', '*')).toBe('gh issue view')
    expect(trimTrailing('a*b', '*')).toBe('a*b')
    expect(trimTrailing('///', '/')).toBe('')
    const start = Date.now()
    expect(trimTrailing('/'.repeat(200_000) + 'x', '/')).toHaveLength(200_001)
    expect(trimTrailing('*'.repeat(200_000) + 'x', '*')).toHaveLength(200_001)
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

// #173: shell commands that reach the network mark the run unless the goal's map names them
const OWN = 'https://github.com/me/repo.git'
let db: Database
const now = new Date().toISOString()

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, { id: 'g1', name: 'Net', description: null, status: 'active', working_dir: tmpdir(), created_at: now, updated_at: now },
    { objective: 'Fix things', autonomy: { 'code.pull_request': 'auto' } })
})

describe('built-in network commands', () => {
  it('marks curl, iwr, wget, npm view, gh api reads and git clone of another repo, anywhere in the command', () => {
    for (const [cmd, name] of [
      ['curl https://x', 'curl'], ['iwr https://x', 'iwr'], ['wget x', 'wget'], ['npm view pkg', 'npm view'],
      ['gh api repos/o/r/issues', 'gh api'], ['gh api -X GET repos/o/r/issues', 'gh api'],
      ['git clone https://github.com/other/repo', 'git clone'],
      ['cd x && curl https://x', 'curl'], ['echo a | wget x', 'wget'], ['ls; npm view pkg', 'npm view'],
    ] as const) {
      expect(builtinNetworkPart(cmd, OWN), cmd).toBe(name)
      expect(untrustedLabel({}, 'Bash', { command: cmd }, OWN), cmd).toBe(`Bash: ${name} (built-in network command)`)
    }
  })

  it('leaves gh api writes to the map and git against the own origin unmarked', () => {
    for (const cmd of ['gh api -X POST repos/o/r/issues', 'gh api --method PATCH repos/o/r', 'git fetch', 'git fetch origin', 'git pull',
      'git fetch --prune origin', `git fetch ${OWN}`, 'git fetch git@github.com:me/repo.git', 'grep x y', 'sed -n 1p f', 'npm test']) {
      expect(builtinNetworkPart(cmd, OWN), cmd).toBeNull()
    }
    expect(builtinNetworkPart('git fetch https://github.com/other/repo', OWN)).toBe('git fetch')
    expect(builtinNetworkPart('git pull https://github.com/other/repo main', OWN)).toBe('git pull')
  })

  it('lets a rule of any category, trusted-read included, decide the command', () => {
    expect(untrustedLabel({ 'Bash(curl*)': TRUSTED_READ_CATEGORY }, 'Bash', { command: 'curl https://x' })).toBeNull()
    expect(untrustedLabel({ 'Bash(curl*)': 'web.read' }, 'Bash', { command: 'curl https://x' })).toBeNull()
    expect(untrustedLabel({ 'Bash(curl*)': 'untrusted' }, 'Bash', { command: 'curl https://x' })).toBe('Bash: curl')
  })

  it('marks an unmapped network command chained after a mapped one', () => {
    const map = { 'Bash(git status*)': 'git.read', 'Bash(curl https://ok*)': TRUSTED_READ_CATEGORY }
    for (const cmd of ['git status && curl https://evil.example', 'git status; wget x', 'git status | npm view pkg', 'curl https://ok && curl https://evil']) {
      expect(untrustedLabel(map, 'Bash', { command: cmd }, OWN), cmd).toMatch(/built-in network command/)
    }
    expect(untrustedLabel(map, 'Bash', { command: 'git status && curl https://ok/x' }, OWN)).toBeNull()
    expect(untrustedLabel(map, 'Bash', { command: 'git status && git fetch origin' }, OWN)).toBeNull()
    // A name-only rule still decides the whole command
    expect(untrustedLabel({ Bash: 'web.read' }, 'Bash', { command: 'git status && curl https://x' }, OWN)).toBeNull()
  })

  it('marks the run in the guard and records the command to map', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    expect(guardToolCallForRun(db, run.id, 'Bash', { command: 'grep -r x .' }).decision).toBe('allow')
    expect(getRun(db, run.id)!.untrusted_source).toBeNull()
    expect(guardToolCallForRun(db, run.id, 'PowerShell', { command: 'Invoke-WebRequest https://x' }).decision).toBe('allow')
    expect(getRun(db, run.id)!.untrusted_source).toBe('PowerShell: Invoke-WebRequest (built-in network command)')
    expect(listToolCalls(db, 'g1')).toEqual([expect.objectContaining({ category: 'untrusted', decision: 'allow', reason: 'built-in network command: Invoke-WebRequest' })])
  })

  it('lists each unmapped network command from recent runs with the rule to add', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    guardToolCallForRun(db, run.id, 'Bash', { command: 'curl https://x' })
    guardToolCallForRun(db, run.id, 'Bash', { command: 'curl https://y' })
    guardToolCallForRun(db, run.id, 'PowerShell', { command: 'Invoke-WebRequest https://x' })
    expect(unmappedNetworkCommands(db, 'g1')).toEqual([
      { tool: 'PowerShell', command: 'Invoke-WebRequest', rule: 'PowerShell(Invoke-WebRequest*)' },
      { tool: 'Bash', command: 'curl', rule: 'Bash(curl*)' },
    ])
  })

  it('never refuses or marks a trusted-read command, and refuses it as an action category', () => {
    updateGoal(db, 'g1', { tool_map: { 'Bash(curl*)': TRUSTED_READ_CATEGORY }, autonomy: { [TRUSTED_READ_CATEGORY]: 'off' } })
    const run = insertRun(db, 'g1', 'manual', 'running')
    expect(guardToolCallForRun(db, run.id, 'Bash', { command: 'curl https://x' })).toMatchObject({ decision: 'allow', category: TRUSTED_READ_CATEGORY })
    expect(getRun(db, run.id)!.untrusted_source).toBeNull()
    expect(() => addItem(db, 'g1', run.id, { goal: 'x', action: { category: TRUSTED_READ_CATEGORY, summary: 'x' } })).toThrow(/trusted-read/)
  })
})

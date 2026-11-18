import { expect, test } from 'claude-code/testing'

import { GITHUB, STATUS, refineRules, reviewRules, triageRules, type Forge } from '../hooks/templates'

// The gh write subcommands the repo templates refused before the forge adapter, written out
// so that dropping or renaming one in GITHUB fails here
const GH_WRITES = ['pr comment', 'pr close', 'pr edit', 'pr review', 'pr reopen', 'pr ready',
  'issue comment', 'issue close', 'issue create', 'issue delete', 'issue edit', 'issue lock', 'issue reopen', 'issue transfer', 'issue pin', 'issue develop',
  'api', 'auth', 'repo', 'release', 'secret', 'variable', 'workflow', 'gist', 'ssh-key', 'gpg-key', 'label']

test('GitHub keeps the write subcommands the repo templates had before the forge (#44)', async () => {
  expect(GITHUB.writes).toEqual(GH_WRITES)
  expect(GITHUB.write).toBe('github.write')
  const review = reviewRules()
  for (const w of GH_WRITES) {
    expect(review[`Bash(gh ${w}*)`]).toBe('github.write')
    expect(review[`PowerShell(gh ${w}*)`]).toBe('github.write')
  }
})

test('the repo templates take their write rules from a forge, GitHub by default (#44)', async () => {
  for (const rules of [reviewRules, refineRules, triageRules]) expect(rules(GITHUB)).toEqual(rules())
})

test('another forge brings its own CLI, writes and category, and none of GitHub\'s', async () => {
  const other: Forge = { cli: 'glab', writes: ['mr merge', 'label'], write: 'forge.write', prCheck: 'gitlab_mr' }
  expect(reviewRules(other)['Bash(glab mr merge*)']).toBe('forge.write')
  expect(reviewRules(other)['PowerShell(glab label*)']).toBe('forge.write')
  // The refiner names label writes one by one, so the blanket rule is left out
  expect(refineRules(other)['Bash(glab label*)']).toBeUndefined()
  expect(Object.keys(reviewRules(other)).some((k) => k.includes('gh release'))).toBe(false)
  expect(Object.keys(reviewRules()).some((k) => k.includes('gh release'))).toBe(true)
})

test('a fixer status names its forge\'s pull request check, github_pr by default (#44)', async () => {
  expect(STATUS('PR #<number> awaiting review', 'pull request')).toBe(STATUS('PR #<number> awaiting review', 'pull request', GITHUB))
  expect(STATUS('open', 'pull request')).toContain('kind github_pr,')
  const other: Forge = { cli: 'glab', writes: [], write: 'forge.write', prCheck: 'gitlab_mr' }
  const status = STATUS('open', 'merge request', other)
  expect(status).toContain('kind gitlab_mr,')
  expect(status).not.toContain('github_pr')
})

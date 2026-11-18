import { expect, test } from 'claude-code/testing'

import { GITHUB, refineRules, reviewRules, triageRules, type Forge } from '../hooks/templates'

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
  const other: Forge = { cli: 'glab', writes: ['mr merge', 'label'], write: 'forge.write' }
  expect(reviewRules(other)['Bash(glab mr merge*)']).toBe('forge.write')
  expect(reviewRules(other)['PowerShell(glab label*)']).toBe('forge.write')
  // The refiner names label writes one by one, so the blanket rule is left out
  expect(refineRules(other)['Bash(glab label*)']).toBeUndefined()
  expect(Object.keys(reviewRules(other)).some((k) => k.includes('gh release'))).toBe(false)
  expect(Object.keys(reviewRules()).some((k) => k.includes('gh release'))).toBe(true)
})

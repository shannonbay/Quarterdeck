import { expect, test } from 'claude-code/testing'

import { GITHUB, refineRules, reviewRules, triageRules, type Forge } from '../hooks/templates'

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

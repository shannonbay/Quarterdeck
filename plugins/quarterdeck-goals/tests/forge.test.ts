import { expect, test } from 'claude-code/testing'

import { GITHUB, STATUS, refineRules, reviewRules, triageRules, type Forge } from '../hooks/templates'

test('the repo templates take their write rules from a forge, GitHub by default (#44)', async () => {
  for (const rules of [reviewRules, refineRules, triageRules]) expect(rules(GITHUB)).toEqual(rules())
})

test('another forge brings its own CLI, writes and category, and none of GitHub\'s', async () => {
  const other: Forge = { cli: 'glab', writes: ['mr merge', 'label'], write: 'forge.write', prCheck: 'gitlab_mr', issueRead: 'glab issue view <number>', prRead: 'glab mr view <number>', prInlineRead: 'glab mr view <number> --comments' }
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
  const other: Forge = { cli: 'glab', writes: [], write: 'forge.write', prCheck: 'gitlab_mr', issueRead: 'glab issue view <number>', prRead: 'glab mr view <number>', prInlineRead: 'glab mr view <number> --comments' }
  const status = STATUS('open', 'merge request', other)
  expect(status).toContain('kind gitlab_mr,')
  expect(status).not.toContain('github_pr')
})

test('the GitHub forge carries the read commands, unchanged and trusting only the owner, members and collaborators (#44)', async () => {
  expect(GITHUB.issueRead).toBe(`gh issue view <number> --json title,body,comments --jq '{title, body, comments: [.comments[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {author: .author.login, body}]}'`)
  expect(GITHUB.prRead).toBe(`gh pr view <number> --json comments,reviews --jq '{comments: [.comments[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, author: .author.login, body}], reviews: [.reviews[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, author: .author.login, state, body}]}'`)
  expect(GITHUB.prInlineRead).toBe(`gh api repos/<owner>/<name>/pulls/<number>/comments --jq '[.[] | select(.author_association | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, path, line, author: .user.login, body}]'`)
})

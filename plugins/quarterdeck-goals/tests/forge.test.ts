import { expect, test } from 'claude-code/testing'

import { CLARIFY_LABEL, GITHUB, REFINED_LABEL, STATUS, TEMPLATES, clarifyReplyWatch, issueWatch, needsRefinementWatch, prCommentWatch, pullWatch, refineRules, refineWatch, refinedWatch, reviewRules, triageRules, triageWatch, type Forge } from '../hooks/templates'

test('the repo templates take their watch commands from the GitHub forge, unchanged (#44)', async () => {
  expect(GITHUB.watches.pulls(true)).toBe(pullWatch(true))
  expect(GITHUB.watches.issues(false)).toBe(issueWatch(false))
  expect(GITHUB.watches.refined()).toBe(refinedWatch())
  expect(GITHUB.watches.triage()).toBe(triageWatch())
  expect(GITHUB.watches.needsRefinement()).toBe(needsRefinementWatch())
  expect(GITHUB.watches.clarifyReplies()).toBe(clarifyReplyWatch())
  expect(GITHUB.watches.prComments()).toBe(prCommentWatch())
  expect(GITHUB.watches.branchFailures('main')).toBe('gh run list --branch main --status failure --limit 20 --json databaseId --jq ".[].databaseId"')
  const fixer = TEMPLATES.find((t) => t.name === 'Issue Fixer')!
  const commands = Object.values(fixer.watches!('anything')).map((w) => w.command)
  expect(commands).toContain(GITHUB.watches.fixFailures())
  expect(commands).toContain(GITHUB.watches.fixConflicts())
  expect(GITHUB.watches.fixFailures()).toContain('gh run list --event pull_request --status failure')
  expect(GITHUB.watches.fixConflicts()).toContain('CONFLICTING')
})

test('the refiner watches issues through its forge (#44)', async () => {
  const other: Forge = { ...GITHUB, watches: { ...GITHUB.watches, issues: (trusted, without = []) => `glab issue list ${trusted} ${without.join(',')}` } }
  expect(refineWatch(true, other)).toMatch(/^glab issue list true /)
  expect(refineWatch(true)).toBe(issueWatch(true, [REFINED_LABEL, CLARIFY_LABEL, 'help wanted']))
})

test('the repo templates take their write rules from a forge, GitHub by default (#44)', async () => {
  for (const rules of [reviewRules, refineRules, triageRules]) expect(rules(GITHUB)).toEqual(rules())
})

test('another forge brings its own CLI, writes and category, and none of GitHub\'s', async () => {
  const other: Forge = { cli: 'glab', writes: ['mr merge', 'label'], write: 'forge.write', prCheck: 'gitlab_mr', issueRead: 'glab issue view <number>', prRead: 'glab mr view <number>', prInlineRead: 'glab mr view <number> --comments', watches: GITHUB.watches }
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
  const other: Forge = { cli: 'glab', writes: [], write: 'forge.write', prCheck: 'gitlab_mr', issueRead: 'glab issue view <number>', prRead: 'glab mr view <number>', prInlineRead: 'glab mr view <number> --comments', watches: GITHUB.watches }
  const status = STATUS('open', 'merge request', other)
  expect(status).toContain('kind gitlab_mr,')
  expect(status).not.toContain('github_pr')
})

test('the GitHub forge carries the read commands, unchanged and trusting only the owner, members and collaborators (#44)', async () => {
  expect(GITHUB.issueRead).toBe(`gh issue view <number> --json title,body,comments --jq '{title, body, comments: [.comments[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {author: .author.login, body}]}'`)
  expect(GITHUB.prRead).toBe(`gh pr view <number> --json comments,reviews --jq '{comments: [.comments[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, author: .author.login, body}], reviews: [.reviews[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, author: .author.login, state, body}]}'`)
  expect(GITHUB.prInlineRead).toBe(`gh api repos/<owner>/<name>/pulls/<number>/comments --jq '[.[] | select(.author_association | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, path, line, author: .user.login, body}]'`)
})

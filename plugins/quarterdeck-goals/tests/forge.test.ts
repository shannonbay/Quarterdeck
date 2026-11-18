import { expect, test } from 'claude-code/testing'

import { CLARIFY_LABEL, GITHUB, ISSUE_FIX_REFINED_INTAKE, ISSUE_FIX_WORK, REFINED_LABEL, issueFixIntake, issueFixRefinedIntake, issueFixWork, STATUS, TEMPLATES, clarifyReplyWatch, issueWatch, needsRefinementWatch, prCommentWatch, pullWatch, refineRules, refineWatch, refinedWatch, reviewRules, triageRules, triageWatch, type Forge } from '../hooks/templates'

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

test("the issue fixer's instructions read issues and pull requests through its forge (#44)", async () => {
  const other: Forge = { ...GITHUB, issueRead: 'OTHER-ISSUE-READ', prRead: 'OTHER-PR-READ', prInlineRead: 'OTHER-INLINE-READ', prCheck: 'other_pr' }
  for (const text of [issueFixIntake(other), issueFixRefinedIntake(other)]) {
    expect(text).toContain('Read each with OTHER-ISSUE-READ,')
    expect(text).not.toContain(GITHUB.issueRead)
  }
  const work = issueFixWork(other)
  expect(work).toContain("read its feedback with OTHER-PR-READ, and a review's inline comments with OTHER-INLINE-READ ")
  expect(work).toContain('status_check (kind other_pr,')
  for (const github of [GITHUB.prRead, GITHUB.prInlineRead, 'kind github_pr']) expect(work).not.toContain(github)
  // The GitHub goal keeps the gh commands it had.
  expect(ISSUE_FIX_REFINED_INTAKE).toContain('Read each with gh issue view <number> --json title,body,comments --jq ')
  expect(ISSUE_FIX_WORK).toContain('read its feedback with gh pr view <number> --json comments,reviews --jq ')
  expect(ISSUE_FIX_WORK).toContain('status_check (kind github_pr,')
})

test("the issue fixer's other commands come from its forge (#44)", async () => {
  const other: Forge = { ...GITHUB, fixer: { runBranch: 'X-RUN-BRANCH', runLog: 'X-RUN-LOG', prBase: 'X-PR-BASE', openIssues: 'X-OPEN-ISSUES', labelledIssues: (label) => `X-LABELLED ${label}`, allPulls: 'X-ALL-PULLS' } }
  const text = `${issueFixRefinedIntake(other)} ${issueFixWork(other)}`
  for (const command of ['find its branch with X-RUN-BRANCH.', 'read the failure with X-RUN-LOG,', 'find the base with X-PR-BASE:', '(X-OPEN-ISSUES, not their titles', `with X-LABELLED ${REFINED_LABEL} (not their text)`, 'a pull request from one (X-ALL-PULLS)']) expect(text).toContain(command)
  expect(text).not.toMatch(/\bgh (run|pr list|pr view <number> --json baseRefName|issue list)/)
  // The GitHub goal keeps the gh commands it had.
  const github = `${ISSUE_FIX_REFINED_INTAKE} ${ISSUE_FIX_WORK}`
  for (const command of ['gh run view <id> --json headBranch', 'gh run view <id> --log-failed', 'gh pr view <number> --json baseRefName', 'gh issue list --json number,author', `gh issue list --state open --label ${REFINED_LABEL} --limit 1000 --json number,labels`, 'gh pr list --state all --limit 1000 --json number,headRefName']) expect(github).toContain(command)
})

test('the refiner watches issues through its forge (#44)', async () => {
  const other: Forge = { ...GITHUB, watches: { ...GITHUB.watches, issues: (trusted, without = []) => `glab issue list ${trusted} ${without.join(',')}` } }
  expect(refineWatch(true, other)).toMatch(/^glab issue list true /)
  expect(refineWatch(true)).toBe(issueWatch(true, [REFINED_LABEL, CLARIFY_LABEL, 'help wanted']))
})

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

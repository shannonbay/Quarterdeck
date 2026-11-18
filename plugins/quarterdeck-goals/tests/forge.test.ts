import { expect, test } from 'claude-code/testing'

import { CLARIFY_LABEL, GITHUB, ISSUE_REFINE_WORK, issueRefineWork, NEEDS_REFINEMENT_LABEL, ISSUE_FIX_REFINED_INTAKE,ISSUE_FIX_WORK, REFINED_LABEL, issueFixIntake, issueFixRefinedIntake, issueFixWork, ISSUE_TRIAGE, issueTriage, PR_REVIEW, prReview, REFINE_INTAKE, REFINE_PICKED_INTAKE, refineIntake, refinePickedIntake, STATUS, TEMPLATES, clarifyReplyWatch, githubRules, issueWatch, needsRefinementWatch, prCommentWatch, pullWatch, refineRules, refineWatch, refinedWatch, reviewRules, SCHEDULE_COMMAND, SCHEDULE_WITH_FLAGS, scheduleCommand, scheduleWithFlags, triageRules, triageWatch, type Forge } from '../hooks/templates'

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

test("the refiner's intake reads issues through its forge (#44)", async () => {
  const other: Forge = { ...GITHUB, issueRead: 'OTHER-ISSUE-READ' }
  for (const text of [refineIntake(other), refinePickedIntake(other)]) {
    expect(text).toContain('Read each with OTHER-ISSUE-READ,')
    expect(text).not.toContain(GITHUB.issueRead)
  }
  // The GitHub goal keeps the gh command it had.
  for (const text of [REFINE_INTAKE, REFINE_PICKED_INTAKE]) expect(text).toContain('Read each with gh issue view <number> --json title,body,comments --jq ')
})

test("the refiner's other commands come from its forge (#44)", async () => {
  const other: Forge = { ...GITHUB, refiner: {
    replyRead: 'X-REPLY-READ', comment: 'X-COMMENT', labelEdit: 'X-LABEL-EDIT',
    relabel: (add, remove) => `X-RELABEL +${add}${remove ? ` -${remove}` : ''}`, removeLabel: (label) => `X-REMOVE ${label}`,
    labelList: 'X-LABEL-LIST', labelCreate: 'X-LABEL-CREATE', openIssues: 'X-OPEN-ISSUES',
  } }
  const text = `${refinePickedIntake(other)} ${issueRefineWork(other)}`
  for (const command of [`add X-REMOVE ${NEEDS_REFINEMENT_LABEL} to its X-LABEL-EDIT.`, 'post it with X-COMMENT, then add the label with X-RELABEL +<label>, and', 'Read the reply with X-REPLY-READ,', `(X-RELABEL +${REFINED_LABEL} -${CLARIFY_LABEL})`, 'labels exist with X-LABEL-LIST (', 'the exact X-LABEL-CREATE commands', '(X-OPEN-ISSUES, not their titles']) expect(text).toContain(command)
  expect(text).not.toMatch(/\bgh (issue (comment|edit|list)|label)|--(add|remove)-label/)
  // The GitHub goal keeps the gh commands it had.
  const github = `${REFINE_PICKED_INTAKE} ${ISSUE_REFINE_WORK}`
  for (const command of [`add --remove-label ${NEEDS_REFINEMENT_LABEL} to its gh issue edit.`, 'gh issue comment <number> --body-file <file>', 'gh issue edit <number> --add-label <label>', `gh issue edit <number> --add-label ${REFINED_LABEL} --remove-label ${CLARIFY_LABEL}`, `gh issue view <number> --json comments --jq '.comments[] | select(.id == "<comment id>")`, 'gh label list --limit 1000 --json name', 'exact gh label create commands', 'gh issue list --json number,author,labels']) expect(github).toContain(command)
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
  const other: Forge = { cli: 'glab', writes: ['mr merge', 'label'], write: 'forge.write', prCheck: 'gitlab_mr', issueRead: 'glab issue view <number>', prRead: 'glab mr view <number>', prInlineRead: 'glab mr view <number> --comments', watches: GITHUB.watches, fixer: GITHUB.fixer, refiner: GITHUB.refiner, rules: GITHUB.rules }
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

test("the refiner's and triage's tool rules name the forge's commands, not gh's (#44)", async () => {
  const other: Forge = { ...GITHUB, cli: 'xx', writes: ['issue comment', 'issue edit', 'label', 'api'], write: 'xx.write', rules: {
    prCreate: 'xx mr create', prMerge: 'xx mr merge', issueView: 'xx issue view', issueList: 'xx issue list',
    issueComment: 'xx issue note', issueEdit: 'xx issue update', labelCreate: 'xx label new', labelWrites: ['xx label rm'], addLabel: '--label',
    prView: 'xx mr view', prDiff: 'xx mr diff', prCheckout: 'xx mr checkout', reviewPost: 'xx mr note',
    inlineRead: 'xx mr discussions', inlineWrites: ['xx mr discussions *--post'],
  } }
  const refine = refineRules(other)
  expect(Object.keys(refine).filter((k) => k.includes('gh '))).toEqual([])
  expect(refine['Bash(xx issue note*)']).toBe('github.issue')
  expect(refine['PowerShell(xx issue update*)']).toBe('github.issue')
  expect(refine['Bash(xx label new*)']).toBe('github.issue')
  expect(refine['Bash(xx label rm*)']).toBe('xx.write')
  expect(refine['Bash(xx mr merge*)']).toBe('github.write')
  expect(refine['Bash(xx issue view*)']).toBe('untrusted')
  const triage = triageRules(other)
  expect(Object.keys(triage).filter((k) => k.includes('gh '))).toEqual([])
  expect(triage['Bash(xx issue update*)']).toBe('github.label')
  expect(triage['Bash(xx issue update * --label needs-refinement)']).toBe('github.schedule')
  expect(triage['PowerShell(xx issue update *-* --label needs-refinement)']).toBe('github.label')
  expect(triage['Bash(xx issue list*)']).toBe('untrusted')
  const review = reviewRules(other)
  expect(review['Bash(xx mr create*)']).toBe('github.write')
  // The reviewer's reads and its one write are the forge's too.
  expect(Object.keys(review).filter((k) => k.includes('gh '))).toEqual([])
  expect(review['Bash(xx mr note*)']).toBe('github.review')
  for (const k of ['xx mr view*', 'xx mr diff*', 'xx mr checkout*']) expect(review[`PowerShell(${k})`]).toBe('untrusted')
  // The fixer's inline comment read, and the forms of it that write.
  const fixer = githubRules('code.merge', other)
  expect(Object.keys(fixer).filter((k) => k.includes('gh '))).toEqual([])
  expect(fixer['Bash(xx mr discussions*)']).toBe('untrusted')
  expect(fixer['Bash(xx mr discussions *--post*)']).toBe('xx.write')
  // GitHub's keep their gh commands.
  const ghFixer = githubRules('code.merge')
  expect(ghFixer['Bash(gh api repos/*/pulls/*/comments*)']).toBe('untrusted')
  for (const k of ['gh api repos/*/pulls/*/comments*--method*', 'gh api repos/*/pulls/*/comments*-X*', 'gh api repos/*/pulls/*/comments*-f*', 'gh api repos/*/pulls/*/comments*--input*', 'gh api repos/* -*/pulls/*/comments*']) {
    expect(ghFixer[`Bash(${k})`]).toBe('github.write')
  }
  const ghReview = reviewRules()
  expect(ghReview['Bash(gh api repos/*/pulls/*/reviews*)']).toBe('github.review')
  for (const k of ['gh pr view*', 'gh pr diff*', 'gh pr checkout*']) expect(ghReview[`Bash(${k})`]).toBe('untrusted')
  // GitHub's rules keep their gh commands.
  const gh = refineRules()
  for (const k of ['gh issue comment*', 'gh issue edit*', 'gh label create*', 'gh label delete*', 'gh label edit*', 'gh label clone*', 'gh pr create*', 'gh pr merge*', 'gh issue view*']) {
    expect(gh[`Bash(${k})`]).toBeDefined()
  }
  expect(triageRules()['Bash(gh issue list*)']).toBe('untrusted')
})

test("the PR reviewer text names the forge's commands, GitHub's by default (#44)", async () => {
  expect(prReview()).toBe(PR_REVIEW)
  const other: Forge = { ...GITHUB, issueRead: 'X-ISSUE-READ', reviewer: {
    closingIssues: 'X-CLOSING', headBranch: 'X-HEAD', body: 'X-BODY', checkout: 'X-CHECKOUT', postReview: 'X-POST', openPulls: 'X-OPEN-PULLS',
  } }
  const text = prReview(other)
  for (const s of ['X-ISSUE-READ', 'X-CLOSING', 'X-HEAD', 'X-BODY', 'X-CHECKOUT', 'X-POST', 'X-OPEN-PULLS']) expect(text).toContain(s)
  // Only the "(gh repo is refused)" note still names gh; it goes with the GitHub wording.
  expect(text.replace('(gh repo is refused)', '')).not.toMatch(/\bgh (pr|api|issue) /)
})

test("the triage text names the forge's commands, GitHub's by default (#44)", async () => {
  expect(issueTriage()).toBe(ISSUE_TRIAGE)
  const other: Forge = { ...GITHUB, triage: {
    read: 'X-READ', labels: 'X-LABELS', labelCreate: 'X-LABEL-CREATE', duplicates: 'X-DUPLICATES',
    addLabels: (labels) => `X-ADD <${labels}>`, untriaged: 'X-UNTRIAGED',
  } }
  const text = issueTriage(other)
  for (const s of ['X-READ', 'X-LABELS', 'X-LABEL-CREATE', 'X-DUPLICATES', 'X-ADD <<label>,<label>,triaged>', 'X-UNTRIAGED']) expect(text).toContain(s)
  // The needs-refinement command still comes from the forge's rules, which this forge keeps as GitHub's.
  expect(text.replace(/gh issue edit[^,]*needs-refinement[^)]*\)?/g, '').replace('any other gh issue edit', '')).not.toMatch(/gh (issue|label) /)
})

test("the needs-refinement command is built from the forge's issue edit and add-label flag (#44)", async () => {
  expect(SCHEDULE_COMMAND).toBe('gh issue edit * --add-label needs-refinement')
  expect(SCHEDULE_WITH_FLAGS).toBe('gh issue edit *-* --add-label needs-refinement')
  expect(scheduleCommand()).toBe(SCHEDULE_COMMAND)
  const other: Forge = { ...GITHUB, rules: { ...GITHUB.rules, issueEdit: 'xx issue update', addLabel: '--label' } }
  expect(scheduleCommand(other)).toBe('xx issue update * --label needs-refinement')
  expect(scheduleWithFlags(other)).toBe('xx issue update *-* --label needs-refinement')
  const text = issueTriage(other)
  expect(text).toContain('with xx issue update <numbers> --label needs-refinement and nothing else in the command (any other xx issue update needs its own proposal)')
  expect(text).not.toContain('gh issue edit <numbers>')
})

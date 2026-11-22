import { expect, test } from 'claude-code/testing'

import { CI_FIX, FORGE_TEMPLATES, forgeAnswer, forgeDecision, ciFix, CLARIFY_LABEL, cleanReview, GITHUB, PR_REREVIEW, prRereview, ISSUE_REFINE_WORK, issueRefineWork, NEEDS_REFINEMENT_LABEL, ISSUE_FIX_REFINED_INTAKE,ISSUE_FIX_WORK, REFINED_LABEL, issueFixIntake, issueFixRefinedIntake, issueFixWork, ISSUE_TRIAGE, issueTriage, PR_REVIEW, prReview, REFINE_INTAKE, REFINE_PICKED_INTAKE, refineIntake, refinePickedIntake, STATUS, TEMPLATES, clarifyReplyWatch, githubRules, issueWatch, needsRefinementWatch, prCommentWatch, pullWatch, refineRules, refineWatch, refinedWatch, reviewRules, baseRecoveredWatch, ISSUE_FIX_RECOVERED_WATCH, SCHEDULE_COMMAND, SCHEDULE_WITH_FLAGS, scheduleCommand, scheduleWithFlags, triageRules, triageWatch, type Forge } from '../hooks/templates'

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
  expect(fixer.watches!('anything')[ISSUE_FIX_RECOVERED_WATCH]).toEqual({ command: GITHUB.watches.fixBaseRecovered(), every_minutes: 10 })
  expect(GITHUB.watches.fixBaseRecovered()).toBe(baseRecoveredWatch())
})

test("the issue fixer's base-recovered watch is one gh call that cmd.exe and sh both read the same way", () => {
  const watch = baseRecoveredWatch()
  expect(watch).toMatch(/^gh api "repos\/\{owner\}\/\{repo\}\/actions\/runs\?per_page=100" --jq "/)
  expect(watch).not.toContain('$') // sh would expand a jq variable inside the double quotes
  // cmd.exe reads what is inside each jq string literal (between \" pairs) as unquoted
  const literals = [...watch.matchAll(/\\"([^\\]*)\\"/g)].map((m) => m[1]!)
  expect(literals).toContain('issue-fix/')
  for (const l of literals) expect(l).not.toMatch(/[|<>&^]/)
  expect(watch).toContain('.pull_requests[0].base.ref') // each pull request's own base, so a stacked one compares with its base branch
})

test('the issue fixer merges a fixed base branch in, from its own watch or the CI watch', () => {
  const work = issueFixWork(GITHUB)
  expect(work).toContain(`under "${ISSUE_FIX_RECOVERED_WATCH}"`)
  expect(work).toContain('external_ref ci-recovered:<branch>@<sha>')
  expect(work).toContain('gh pr list --head <branch> --state open')
  expect(work).toContain("the base's CI already passes again, merge the base in")
})

test("the issue fixer's comment watch leaves out the PR reviewer's clean reviews, by the wording the reviewer is told to use", async () => {
  expect(cleanReview('<sha>')).toBe('Reviewed at <sha>: no problems found')
  expect(PR_REVIEW).toContain(`"${cleanReview('<sha>')}"`)
  expect(PR_REREVIEW).toContain(`"${cleanReview('<sha>')}"`)
  const watch = prCommentWatch()
  expect(watch).toContain('| test(\\"Reviewed at [0-9a-f]+: no problems found\\") | not)')
  // cmd.exe reads the jq string as unquoted, so a ^ in it would be stripped
  expect(watch).not.toContain('^')
  expect(new RegExp(cleanReview('[0-9a-f]+')).test('Reviewed at 13c101a: no problems found. Refs #143')).toBe(true)
  expect(new RegExp(cleanReview('[0-9a-f]+')).test('Reviewed at ec1456c: this does not build.')).toBe(false)
})

test("the issue fixer's instructions read issues and pull requests through its forge (#44)", async () => {
  const other: Forge = { ...GITHUB, issueRead: 'OTHER-ISSUE-READ', prRead: 'OTHER-PR-READ', prInlineRead: 'OTHER-INLINE-READ', prCheck: 'other_pr' }
  for (const text of [issueFixIntake(other), issueFixRefinedIntake(other)]) {
    expect(text).toContain('Read each with OTHER-ISSUE-READ,')
    expect(text).not.toContain(GITHUB.issueRead)
  }
  const work = issueFixWork(other)
  expect(work).toContain("read its feedback with OTHER-PR-READ, and a review's inline comments with OTHER-INLINE-READ;")
  expect(work).toContain('status_check (kind other_pr,')
  for (const github of [GITHUB.prRead, GITHUB.prInlineRead, 'kind github_pr']) expect(work).not.toContain(github)
  // The GitHub goal reads issues through the issue_read tool (#172) and keeps its gh commands for the rest.
  expect(ISSUE_FIX_REFINED_INTAKE).toContain('Read each with the issue_read tool (repo as owner/name')
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
  // The GitHub goal reads issues through the issue_read tool (#172).
  for (const text of [REFINE_INTAKE, REFINE_PICKED_INTAKE]) expect(text).toContain('Read each with the issue_read tool (repo as owner/name')
})

test("the refiner's other commands come from its forge (#44)", async () => {
  const other: Forge = { ...GITHUB, refiner: {
    replyRead: 'X-REPLY-READ', comment: 'X-COMMENT', labelEdit: 'X-LABEL-EDIT',
    relabel: (add, remove) => `X-RELABEL +${add}${remove ? ` -${remove}` : ''}`, removeLabel: (label) => `X-REMOVE ${label}`,
    labelList: 'X-LABEL-LIST', labelListNote: ' X-LABEL-NOTE', labelCreate: 'X-LABEL-CREATE', openIssues: 'X-OPEN-ISSUES',
  } }
  const text = `${refinePickedIntake(other)} ${issueRefineWork(other)}`
  for (const command of [`add X-REMOVE ${NEEDS_REFINEMENT_LABEL} to its X-LABEL-EDIT.`, 'post it with X-COMMENT, then add the label with X-RELABEL +<label>, and', 'Read the reply with X-REPLY-READ,', `(X-RELABEL +${REFINED_LABEL} -${CLARIFY_LABEL})`, 'labels exist with X-LABEL-LIST X-LABEL-NOTE, and', 'the exact X-LABEL-CREATE commands', '(X-OPEN-ISSUES, not their titles']) expect(text).toContain(command)
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
  const other: Forge = { name: 'GitLab', cli: 'glab', writes: ['mr merge', 'label'], write: 'forge.write', prCheck: 'gitlab_mr', issueRead: 'glab issue view <number>', prRead: 'glab mr view <number>', prInlineRead: 'glab mr view <number> --comments', watches: GITHUB.watches, fixer: GITHUB.fixer, refiner: GITHUB.refiner, rules: GITHUB.rules }
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
  const other: Forge = { name: 'GitLab', cli: 'glab', writes: [], write: 'forge.write', prCheck: 'gitlab_mr', issueRead: 'glab issue view <number>', prRead: 'glab mr view <number>', prInlineRead: 'glab mr view <number> --comments', watches: GITHUB.watches }
  const status = STATUS('open', 'merge request', other)
  expect(status).toContain('kind gitlab_mr,')
  expect(status).not.toContain('github_pr')
})

test('the GitHub forge carries the read commands, unchanged and trusting only the owner, members and collaborators (#44)', async () => {
  // GitHub's issue read goes through the server tool, which shows hidden text as markers (#172).
  expect(GITHUB.issueRead).toContain('issue_read')
  expect(GITHUB.issueRead).not.toContain('gh issue view')
  expect(GITHUB.prRead).toBe(`gh pr view <number> --json comments,reviews --jq '{comments: [.comments[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, author: .author.login, body}], reviews: [.reviews[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR")) | {id, author: .author.login, state, body}]}'`)
  // GitHub's inline comment read goes through the server tool, which no flag can turn into a write (#68).
  expect(GITHUB.prInlineRead).toContain('pr_inline_comments')
  expect(GITHUB.prInlineRead).not.toContain('gh api')
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
  // GitHub has no rule for the inline read (#68): every gh api call falls to gh api*, the write category.
  const ghFixer = githubRules('code.merge')
  expect(Object.keys(ghFixer).filter((k) => k.includes('gh api') && k !== 'Bash(gh api*)' && k !== 'PowerShell(gh api*)')).toEqual([])
  expect(ghFixer['Bash(gh api*)']).toBe('github.write')
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
    closingIssues: 'X-CLOSING', headBranch: 'X-HEAD', body: 'X-BODY', checkout: 'X-CHECKOUT', postReview: 'X-POST', repoNote: '', openPulls: 'X-OPEN-PULLS',
  } }
  const text = prReview(other)
  for (const s of ['X-ISSUE-READ', 'X-CLOSING', 'X-HEAD', 'X-BODY', 'X-CHECKOUT', 'X-POST', 'X-OPEN-PULLS']) expect(text).toContain(s)
  expect(text).not.toMatch(/\bgh (pr|api|issue|repo) |repos\/\{owner\}/)
  expect(text).toContain("action.calls [{command: X-POST with that file's path")
  expect(text).toContain('run the staged command exactly as add_item returned it')
  expect(prReview({ ...other, reviewer: { ...other.reviewer, repoNote: 'X-REPO-NOTE' } })).toContain('}]. X-REPO-NOTE add_item answers')
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
  expect(text).toContain('with xx issue update <numbers> --label needs-refinement exactly as written, unquoted, and nothing else in the command (any other xx issue update needs its own proposal)')
  expect(text).not.toContain('gh issue edit <numbers>')
})

test("the instruction texts name the forge, not GitHub (#44)", async () => {
  expect(GITHUB.name).toBe('GitHub')
  const other: Forge = { ...GITHUB, name: 'Xhub' }
  expect(ciFix(GITHUB)).toBe(CI_FIX)
  expect(prRereview(GITHUB)).toBe(PR_REREVIEW)
  for (const text of [ciFix(other), issueFixWork(other), issueRefineWork(other), prReview(other)]) expect(text).toContain('clone this repo (its Xhub remote)')
  expect(issueFixWork(other)).toContain("you can't reply on Xhub.")
  expect(refinePickedIntake(other)).toContain('(on Xhub, or by answering')
  expect(issueTriage(other)).toContain('I can label them on Xhub later.')
  expect(prRereview(other)).toContain('not on Xhub:')
  for (const text of [ciFix(other), issueFixWork(other), refinePickedIntake(other), issueRefineWork(other), issueTriage(other), prReview(other)]) expect(text).not.toContain('GitHub')
})

test("the CI fixer reads a failure with its forge's command (#44)", async () => {
  const other: Forge = { ...GITHUB, fixer: { ...GITHUB.fixer, runLog: 'xx ci trace <id>' } }
  const text = ciFix(other)
  expect(text).toContain('read the failure with xx ci trace <id>.')
  expect(text).not.toContain('gh run view')
})

test('forgeDecision: an older server means GitHub, an unknown host asks, GitLab is refused for now (#44 step 2)', async () => {
  expect(forgeDecision(null)).toEqual({ kind: 'use', forge: 'github' })
  expect(forgeDecision({ forge: 'github', host: 'github.com' })).toEqual({ kind: 'use', forge: 'github' })
  expect(forgeDecision({ forge: null, host: null })).toEqual({ kind: 'ask' })
  expect(forgeDecision({ forge: null, host: 'codeberg.org' })).toEqual({ kind: 'ask' })
  const gitlab = forgeDecision({ forge: 'gitlab', host: 'git.corp.example' })
  expect(gitlab.kind).toBe('refuse')
  expect(gitlab.kind === 'refuse' && gitlab.message).toContain('GitLab (git.corp.example)')
  expect(forgeAnswer('github')).toEqual({ kind: 'use', forge: 'github' })
  expect(FORGE_TEMPLATES).toEqual(['Issue Triage', 'Issue Refiner', 'Issue Fixer', 'PR Reviewer', 'CI Watch And Fix'])
})

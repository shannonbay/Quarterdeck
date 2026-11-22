/**
 * Reads an issue for the GitHub goal templates (#172): its title and body, and only the comments from the repo's
 * owner, members and collaborators (or the one comment asked for, for a reply watch).
 *
 * It is a tool rather than a `gh issue view` command because the guard sees a command, not its output: here every
 * text field goes through cleanOutsideText, so hidden comments, invisible characters and tag characters reach the
 * run as visible markers. The guard holds the call to the goal's rules (mapped to `untrusted`, calling it marks the
 * run as having read outside text). It changes nothing, so no record().
 */
import { IssueReadSchema } from '../schema.js'
import { cleanOutsideText, defaultRunFile, type RunFile } from '@quarterdeck/core'
import { TRUSTED } from './trusted.js'

interface IssueComment {
  id: string
  authorAssociation: string
  author: { login: string } | null
  body: string
}

interface Issue {
  title: string
  body: string
  comments: IssueComment[]
}

export async function issue_read(args: unknown, run: RunFile = defaultRunFile) {
  const { repo, number, comment_id } = IssueReadSchema.parse(args)
  const answer = await run('gh', ['issue', 'view', String(number), '--repo', repo, '--json', 'title,body,comments'])
  const issue = JSON.parse(answer) as Issue
  const clean = (text: string | null | undefined) => cleanOutsideText(text ?? '').text
  const comments = (issue.comments ?? [])
    .filter((c) => TRUSTED.includes(c.authorAssociation))
    .filter((c) => comment_id === undefined || c.id === comment_id)
    .map((c) => ({ id: c.id, author: c.author?.login ?? null, body: clean(c.body) }))
  return { repo, number, title: clean(issue.title), body: clean(issue.body), comments }
}

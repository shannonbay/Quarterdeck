/**
 * Reads a pull request's inline review comments, only those from the repo's owner, members and collaborators, for
 * the Issue Fixer (#68).
 *
 * It is a tool rather than a `gh api .../comments` command because the guard matches commands with globs: a `*`
 * matches any flag, so no rule could allow the read's `--jq` and refuse every write flag (a clustered `-iX POST`
 * got past rules that named the flags). Here the call is fixed and only reads, so every `gh api` command falls to
 * the goal's write category. The guard holds the call to the goal's rules (the Issue Fixer maps it to
 * `untrusted`, so calling it marks the run as having read outside text). It changes nothing, so no record().
 */
import { PrInlineCommentsSchema } from '../schema.js'
import { cleanOutsideText, defaultRunFile, type RunFile } from '@quarterdeck/core'
import { TRUSTED } from './trusted.js'

interface InlineComment {
  id: number
  path: string
  line: number | null
  original_line?: number | null
  author_association: string
  user: { login: string } | null
  body: string
}

/** `--paginate` prints one JSON array per page, back to back; split them without being fooled by brackets in strings. */
export function parsePages(text: string): unknown[] {
  const out: unknown[] = []
  let depth = 0, start = -1, inString = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '[' || c === '{') { if (depth++ === 0) start = i }
    else if ((c === ']' || c === '}') && --depth === 0) {
      const page: unknown = JSON.parse(text.slice(start, i + 1))
      if (!Array.isArray(page)) throw new Error(`Unexpected answer from GitHub: ${text.slice(start, Math.min(i + 1, start + 200))}`)
      out.push(...page)
    }
  }
  return out
}

export async function pr_inline_comments(args: unknown, run: RunFile = defaultRunFile) {
  const { repo, pr } = PrInlineCommentsSchema.parse(args)
  const answer = await run('gh', ['api', `repos/${repo}/pulls/${pr}/comments`, '--paginate'])
  const comments = (parsePages(answer) as InlineComment[])
    .filter((c) => TRUSTED.includes(c.author_association))
    .map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line ?? null, author: c.user?.login ?? null, body: cleanOutsideText(c.body ?? '').text }))
  return { repo, pr, comments }
}

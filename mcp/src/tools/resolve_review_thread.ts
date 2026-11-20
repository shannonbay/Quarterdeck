/**
 * Marks pull request review threads resolved, for the Issue Fixer after it
 * pushes a change that answers them.
 *
 * It is a tool rather than a `gh api graphql` command because the guard reads a
 * shell command only up to its first `(` or `{`, so it can't tell resolving a
 * thread from any other GraphQL mutation (merging, say). Here the mutation is
 * fixed, and the thread is picked by the comment ids the run read, so it can
 * resolve nothing but a thread of an open pull request that someone it trusts
 * started. The guard holds the call to the goal's rules (the Issue Fixer maps it
 * to code.pull_request, so approving a push approves this too).
 */
import { ResolveReviewThreadSchema } from '../schema.js'
import { defaultRunFile, type RunFile } from '@quarterdeck/core'
import { getOpenPlan } from '../session.js'
import { record } from '../history.js'
import { TRUSTED } from './trusted.js'

const THREADS_QUERY = 'query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){state reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId authorAssociation}}}}}}}'
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'

interface ThreadNode {
  id: string
  isResolved: boolean
  comments: { nodes: { databaseId: number; authorAssociation: string }[] }
}

export async function resolve_review_thread(args: unknown, run: RunFile = defaultRunFile) {
  const { repo, pr, comment_ids } = ResolveReviewThreadSchema.parse(args)
  const [owner, name] = repo.split('/')

  const answer = JSON.parse(await run('gh', [
    'api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${pr}`,
  ])) as { data?: { repository?: { pullRequest?: { state: string; reviewThreads: { nodes: ThreadNode[] } } | null } | null } }
  const pull = answer.data?.repository?.pullRequest
  if (!pull) throw new Error(`Can't find pull request #${pr} in ${repo}.`)
  if (pull.state !== 'OPEN') throw new Error(`Pull request #${pr} is ${pull.state.toLowerCase()}: nothing to resolve.`)

  const resolved: { thread: string; comment_id: number }[] = []
  const already: number[] = []
  const skipped: { comment_id: number; reason: string }[] = []
  const done = new Set<string>()
  for (const id of comment_ids) {
    const thread = pull.reviewThreads.nodes.find((t) => t.comments.nodes.some((c) => c.databaseId === id))
    if (!thread) { skipped.push({ comment_id: id, reason: 'no review thread has that comment (a plain PR comment or a review summary has none)' }); continue }
    if (!TRUSTED.includes(thread.comments.nodes[0]?.authorAssociation ?? '')) { skipped.push({ comment_id: id, reason: "its thread wasn't started by the repo's owner, a member or a collaborator" }); continue }
    if (thread.isResolved) { already.push(id); continue }
    if (done.has(thread.id)) continue
    await run('gh', ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `id=${thread.id}`])
    done.add(thread.id)
    resolved.push({ thread: thread.id, comment_id: id })
  }

  const goal = getOpenPlan()
  if (goal && resolved.length) record(goal, goal, 'review_threads_resolved', { repo, pr, threads: resolved.map((r) => r.thread) })
  return { resolved: resolved.length, threads: resolved, already_resolved: already, skipped }
}

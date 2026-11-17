import { describe, it, expect } from 'vitest'
import { resolve_review_thread } from '../../tools/resolve_review_thread.js'

const thread = (id: string, assoc: string, commentIds: number[], isResolved = false) => ({
  id, isResolved,
  comments: { nodes: commentIds.map((databaseId, i) => ({ databaseId, authorAssociation: i === 0 ? assoc : 'NONE' })) },
})

function fakeGh(state: string, nodes: ReturnType<typeof thread>[]) {
  const calls: string[][] = []
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (args.some((a) => a.startsWith('query=query'))) return JSON.stringify({ data: { repository: { pullRequest: { state, reviewThreads: { nodes } } } } })
    return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } })
  }
  return { calls, run }
}

describe('resolve_review_thread', () => {
  it("resolves the threads of the comments, once each, whichever comment of a thread is named", async () => {
    const { calls, run } = fakeGh('OPEN', [thread('T1', 'OWNER', [10, 11]), thread('T2', 'COLLABORATOR', [20])])
    const r = await resolve_review_thread({ repo: 'octo/my-app', pr: 7, comment_ids: [10, 11, 20] }, run)
    expect(r).toMatchObject({ resolved: 2, already_resolved: [], skipped: [] })
    const mutations = calls.filter((c) => c.some((a) => a.startsWith('query=mutation')))
    expect(mutations.map((c) => c.find((a) => a.startsWith('id=')))).toEqual(['id=T1', 'id=T2'])
    expect(calls.every(([file, ...args]) => file === 'gh' && args[0] === 'api' && args[1] === 'graphql')).toBe(true)
  })

  it("leaves alone a thread someone untrusted started, one that is resolved, and a comment with no thread", async () => {
    const { calls, run } = fakeGh('OPEN', [thread('T1', 'NONE', [10]), thread('T2', 'OWNER', [20], true)])
    const r = await resolve_review_thread({ repo: 'octo/my-app', pr: 7, comment_ids: [10, 20, 99] }, run)
    expect(r.resolved).toBe(0)
    expect(r.already_resolved).toEqual([20])
    expect(r.skipped.map((s) => s.comment_id)).toEqual([10, 99])
    expect(calls).toHaveLength(1) // only the read
  })

  it('refuses a pull request that is not open', async () => {
    const { run } = fakeGh('MERGED', [thread('T1', 'OWNER', [10])])
    await expect(resolve_review_thread({ repo: 'octo/my-app', pr: 7, comment_ids: [10] }, run)).rejects.toThrow(/merged/)
  })

  it('takes only a repo as owner/name and comment ids', async () => {
    const { run } = fakeGh('OPEN', [])
    await expect(resolve_review_thread({ repo: 'octo', pr: 7, comment_ids: [1] }, run)).rejects.toThrow()
    await expect(resolve_review_thread({ repo: 'octo/my-app', pr: 7, comment_ids: [] }, run)).rejects.toThrow()
  })
})

/**
 * The to-do tools through the bundle. b774073 fixed todo_list going over Claude Code's
 * ~50,000-character limit for a tool answer, which only shows on the wire: done to-dos come
 * back clipped and without notes, and the answer is compact JSON.
 *
 * Run with `npm run test:live --prefix mcp` (it builds the bundle first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DONE_TEXT_CHARS } from '@quarterdeck/core'
import { startLiveServer, type LiveServer } from './server.js'

let server: LiveServer
beforeAll(async () => { server = await startLiveServer() })
afterAll(async () => { await server?.stop() })

describe('to-do tools', () => {
  it('adds, rewords and ticks off to-dos, and todo_list stays small with many long done ones', async () => {
    const dir = server.workDir('todos')
    const first = await server.call('todo_add', { working_dir: dir, text: 'Try it on my phone' })
    expect(first).toMatchObject({ item_id: '1', created_list: true })
    const list = first.list_id as string
    expect((await server.call('todo_set', { list_id: list, item_id: '1', text: 'Try it on a phone' })).previous_text).toBe('Try it on my phone')

    // 100 done to-dos of 2,000 characters with notes: in full, the answer would pass 400,000 characters
    const long = 'x'.repeat(2000)
    for (let i = 0; i < 100; i++) {
      const { item_id } = await server.call('todo_add', { working_dir: dir, text: long, list_id: list })
      await server.call('todo_set', { list_id: list, item_id, status: 'completed', notes: long })
    }

    const text = await server.text('todo_list', { working_dir: dir })
    expect(text.length).toBeLessThan(50_000)
    expect(text).not.toContain('\n')
    const [todo] = JSON.parse(text).lists
    expect(todo).toMatchObject({ name: 'To do', open: 1, done: 100 })
    expect(todo.items[0]).toMatchObject({ text: 'Try it on a phone', status: 'pending' })
    expect(todo.items[1]).toMatchObject({ status: 'completed', notes: null })
    expect(todo.items[1].text).toHaveLength(DONE_TEXT_CHARS)
  })
})

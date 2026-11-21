/**
 * #162: expanded goals must not push the pane's overview past Claude Code's
 * tool-result limit, and goal tools must find goals without any expanded goal's detail.
 */
import { expect, test } from 'claude-code/testing'

import { isSpilled } from '../hooks/api'
import { engine, fakeQuarterdeck, goal, PANE, START } from './fixtures'

const twoGoals = () => [goal({ id: 'g1', name: 'Inbox' }), goal({ id: 'g2', name: 'Invoices' })]

/** Expands goals in the pane, as the person would. */
async function expand($: Parameters<Parameters<typeof test>[1]>[0], ids: string[]) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const id of ids) await ui.press({ key: `toggle-${id}` })
  return ui
}

test("Claude Code's current spill wording counts as too large, and the old wordings still do", () => {
  expect(isSpilled('result (68,739 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to C:\\x\\tool-results\\y.txt')).toBe(true)
  expect(isSpilled('<persisted-output>saved</persisted-output>')).toBe(true)
  expect(isSpilled('Output too large (70KB). Full output saved to: /tmp/x')).toBe(true)
  expect(isSpilled('Internal server error')).toBe(false)
})

test('a spilled overview answer gives the "too large" error, not "isn\'t connected"', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, twoGoals(), { spillAll: true })
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goal_detail', goal: 'inbox' } as never)
  const text = String(res.result)
  expect(text).toContain('too large')
  expect(text).not.toContain("isn't connected")
})

test("when the server isn't there, a goal tool still says it isn't connected", async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, twoGoals(), { fail: true })
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goal_detail', goal: 'inbox' } as never)
  expect(String(res.result)).toContain("isn't connected")
})

test('with two goals expanded, the pane reads the cards alone and each goal with its own only: true read', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, twoGoals())
  await $.session.start(START)
  const ui = await expand($, ['g1', 'g2'])
  const reads = fake.of('goals_overview').map((c) => c.input)
  expect(reads.some((r) => JSON.stringify(r.detail) === '[]' && r.only === undefined)).toBe(true)
  expect(reads.some((r) => JSON.stringify(r.detail) === '["g1"]' && r.only === true)).toBe(true)
  expect(reads.some((r) => JSON.stringify(r.detail) === '["g2"]' && r.only === true)).toBe(true)
  // No read asks for more than one goal's detail at once
  expect(reads.every((r) => (r.detail as string[]).length <= 1)).toBe(true)
  await ui.unmount()
})

test('one expanded goal too large: the pane stays online, keeps the other goal, and says which is too big', async ($, on) => {
  const { statuses } = engine(on)
  const fake = fakeQuarterdeck(on, twoGoals(), { spill: ['g2'] })
  await $.session.start(START)
  const ui = await expand($, ['g1', 'g2'])
  expect(await ui.find({ type: 'Text', text: /Offline/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /too big to show expanded/ }))?.text).toContain('Goal Invoices is too big to show expanded')
  expect(await ui.find({ type: 'Text', text: /Goal Inbox is too big/ })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-g1' })).toBeDefined()
  expect(statuses.at(-1)).not.toBe('Quarterdeck: offline')
  expect(fake.of('goals_overview').some((c) => JSON.stringify(c.input.detail) === '["g1"]' && c.input.only === true)).toBe(true)
  await ui.unmount()
})

test('an unchanged expanded goal sends its own etag and keeps its detail', async ($, on) => {
  const { clock } = engine(on)
  const fake = fakeQuarterdeck(on, twoGoals())
  await $.session.start(START)
  const ui = await expand($, ['g1'])
  const before = fake.of('goals_overview').length
  await clock.advance(15_000)
  await clock.settle()
  const later = fake.of('goals_overview').slice(before).map((c) => c.input)
  const own = later.find((r) => JSON.stringify(r.detail) === '["g1"]' && r.only === true)
  expect(own?.etag).toBe('"v0"')
  expect(await ui.find({ key: 'toggle-g1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Offline/ })).toBeUndefined()
  await ui.unmount()
})

test('goal tools find a goal by name while an expanded goal is too large, with a cards-only read', async ($, on) => {
  engine(on, { answers: ['Run it', 'Apply changes'] })
  const fake = fakeQuarterdeck(on, twoGoals(), { spill: ['g2'] })
  await $.session.start(START)
  const ui = await expand($, ['g2'])
  await ui.unmount()
  const before = fake.of('goals_overview').length

  const detail = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goal_detail', goal: 'inbox' } as never)
  expect(String(detail.result)).toContain('Inbox')
  expect(String(detail.result)).not.toContain("isn't connected")
  const run = await $.tool.call({ tool: 'mcp__quarterdeck-goals__run_goal', goal: 'inbox' } as never)
  expect(String(run.result)).not.toContain("isn't connected")
  expect(fake.of('run_goal').map((c) => c.input.goal_id)).toContain('g1')
  const update = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'inbox', status: 'paused' } as never)
  expect(String(update.result)).not.toContain("isn't connected")
  expect(fake.of('update_goal').map((c) => c.input.goal_id)).toContain('g1')

  // The tools' own reads ask for no expanded goal's detail before acting
  const reads = fake.of('goals_overview').slice(before).map((c) => c.input)
  expect(reads[0]).toEqual({ detail: [] })
})

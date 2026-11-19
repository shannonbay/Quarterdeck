import { expect, test } from 'claude-code/testing'

import { engine, fakeQuarterdeck, goal, PANE, START } from './fixtures'

const failed = () => goal({
  id: 'g1',
  name: 'Unsubscribe',
  runs: [
    { id: 'r2', status: 'failed', trigger: 'interval', summary: 'The agent ended without calling end_run', started_at: '2026-11-07T07:50:00Z', ended_at: '2026-11-07T07:50:04Z', agent_id: 'a62da' },
    { id: 'r1', status: 'completed', trigger: 'interval', summary: 'First run. Blocked: Gmail is not connected.', started_at: '2026-11-07T06:50:00Z', ended_at: '2026-11-07T06:51:00Z', agent_id: 'ab1e9' },
  ],
  autonomy: { 'email.archive': 'auto' },
})

test('a goal whose last run failed has Discuss, which brings the failure into the conversation', async ($, on) => {
  const { prompts } = engine(on)
  fakeQuarterdeck(on, [failed(), goal({ id: 'g2', name: 'Inbox' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'discuss-g2' })).toBeUndefined() // only on failed goals
  await ui.press({ key: 'discuss-g1' })
  expect(prompts[0]).toContain('this run of my goal "Unsubscribe" (goal g1, run r2): failed (interval)')
  expect(prompts[0]).toContain('Its summary: The agent ended without calling end_run')
  expect(prompts[0]).toContain('Why did it fail')
  expect(prompts[0]).toContain('agent-a62da.jsonl')
  expect(prompts[0]).toContain('update_goal or set_schedule')
  await ui.unmount()
})

test('expanded, a goal shows no run history, and Discuss this goal… brings its last run', async ($, on) => {
  const { prompts } = engine(on)
  fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-g1' })
  expect(await ui.find({ type: 'Text', text: 'Recent runs' })).toBeUndefined()
  for (const key of ['run-row-r1', 'run-row-r2', 'run-untrusted-r1', 'discuss-run-r1', 'discuss-run-r2']) expect(await ui.find({ key })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: /Open in browser/ })).toBeDefined()
  expect(await ui.find({ key: 'model-change-g1' })).toBeDefined()
  // Pressing opens a question box and sends nothing; Enter on the empty box asks the usual question
  await ui.press({ key: 'discuss-goal-g1' })
  expect(prompts).toEqual([])
  expect((await ui.find({ key: 'discuss-goal-input-g1' }))?.props).toMatchObject({ autoFocus: true, label: 'Your question' })
  await ui.input({ key: 'discuss-goal-input-g1', text: '' })
  expect(prompts[0]).toBe('Let\'s talk about my goal "Unsubscribe" (id g1). Its last run: failed (interval), 2026-11-07T07:50:04Z. Summary: The agent ended without calling end_run. Its agent was a62da: its transcript (agent-a62da.jsonl, under ~/.claude/projects) shows what it actually did. Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm. What\'s working, what isn\'t, and what would you change?')
  expect(await ui.find({ key: 'discuss-goal-input-g1' })).toBeUndefined() // closes after sending
  await ui.unmount()
})

test('Discuss this goal… on a goal with no runs sends the goal prompt alone', async ($, on) => {
  const { prompts } = engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g2', name: 'Inbox' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-g2' })
  await ui.press({ key: 'discuss-goal-g2' })
  await ui.input({ key: 'discuss-goal-input-g2', text: '' })
  expect(prompts[0]).toBe('Let\'s talk about my goal "Inbox" (id g2). Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm. What\'s working, what isn\'t, and what would you change?')
  await ui.unmount()
})

test('a question typed in the Discuss box goes with the goal in place of the usual one', async ($, on) => {
  const { prompts } = engine(on)
  fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'discuss-goal-g1' })
  await ui.input({ key: 'discuss-goal-input-g1', text: '  Should archiving stay on auto? ' })
  expect(prompts[0]).toContain('Its last run: failed (interval)')
  expect(prompts[0]).toContain('agent-a62da.jsonl')
  expect(prompts[0]).not.toContain("What's working")
  expect(prompts[0]!.endsWith('they ask me to confirm.\n\nMy question: Should archiving stay on auto?')).toBe(true)
  // Cancel closes the box and sends nothing
  await ui.press({ key: 'discuss-goal-g1' })
  await ui.press({ key: 'discuss-goal-cancel-g1' })
  expect(await ui.find({ key: 'discuss-goal-input-g1' })).toBeUndefined()
  expect(prompts.length).toBe(1)
  await ui.unmount()
})

test('update_goal shows each change and applies only what the person confirms', async ($, on) => {
  const declined = engine(on, { answer: 'Cancel' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const no = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', autonomy: { 'email.archive': null, 'email.delete': 'off' }, status: 'paused' } as never)
  expect(declined.asked[0]).toBe('Change the goal "Unsubscribe"?\n• email.archive: auto → propose (default)\n• email.delete: propose → off\n• Pause the goal')
  expect(String(no.result)).toContain('declined')
  expect(fake.of('update_goal')).toEqual([])
  const nothing = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub' } as never)
  expect(String(nothing.result)).toContain('Nothing to change')
})

test('update_goal applies confirmed changes', async ($, on) => {
  engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const yes = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', autonomy: { 'email.delete': 'off' } } as never)
  expect(String(yes.result)).toBe('Changed Unsubscribe: email.delete: off.')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', autonomy: { 'email.delete': 'off' } })
})

test('update_goal takes edits to part of the instructions, shows just those, and refuses one that would miss', async ($, on) => {
  const asked = engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Unsubscribe', instructions: 'Find stale senders. Propose one item per sender. Never send mail.' })])
  await $.session.start(START)
  const edits = [{ old: 'Propose one item per sender.', new: 'Propose one item per sender, with its count.' }, { old: ' Never send mail.', new: '' }]
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', instructions_edits: edits } as never)
  expect(asked.asked[0]).toBe('Change the goal "Unsubscribe"?\n• Instructions: replace "Propose one item per sender." with "Propose one item per sender, with its count."\n• Instructions: remove " Never send mail."')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', instructions_edits: edits })

  const missing = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', instructions_edits: [{ old: 'Archive newsletters.', new: 'x' }] } as never)
  expect(String(missing.result)).toContain("don't contain the text to replace")
  const twice = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', instructions_edits: [{ old: 'sender', new: 'x' }] } as never)
  expect(String(twice.result)).toContain('more than once')
  const both = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', instructions: 'x', instructions_edits: edits } as never)
  expect(String(both.result)).toContain('not both')
  expect(asked.asked).toHaveLength(1) // none of those asked the person
  expect(fake.of('update_goal')).toHaveLength(1)
})

test('goal_detail and update_goal read long instructions whole, so an edit past where the pane cuts them works', async ($, on) => {
  engine(on, { answer: 'Apply changes' })
  const long = `${'Read each issue. '.repeat(120)}The first run only sets up the clone.`
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Issue Fixer', instructions: long })])
  await $.session.start(START)
  // Expanded in the pane, its detail has the instructions cut
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  const detail = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goal_detail', goal: 'issue fixer' } as never)
  expect(String(detail.result)).toContain('The first run only sets up the clone.')
  const edits = [{ old: 'The first run only sets up the clone.', new: 'A comment watch starts a run too. The first run only sets up the clone.' }]
  const changed = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'issue fixer', instructions_edits: edits } as never)
  expect(String(changed.result)).toMatch(/^Changed Issue Fixer/)
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', instructions_edits: edits })
  await ui.unmount()
})

test('goal_detail shows a clipped request in full, such as every change of a memory curation', async ($, on) => {
  engine(on)
  const all = 'Changes to your own or pinned memory:\n- Retire m1\n\nOther changes:\n- Merge m2 and m3 into one fact, the last change'
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', needs_you: [{ id: '4', goal: "Tidy this goal's memory: 2 changes", notes: all.slice(0, 40), clipped: true }] })],
    { full: { '4': { id: '4', goal: "Tidy this goal's memory: 2 changes", notes: all } } })
  await $.session.start(START)
  const detail = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goal_detail', goal: 'inbox' } as never)
  expect(String(detail.result)).toContain('Merge m2 and m3 into one fact, the last change')
})

test('update_goal passes a confirmed category merge to the server', async ($, on) => {
  const asked = engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', merge_categories: { 'email.trash': 'email.delete' } } as never)
  expect(asked.asked[0]).toContain('• Merge category email.trash into email.delete')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', merge_categories: { 'email.trash': 'email.delete' } })
})

test('update_goal shows a new watch\'s whole command before it is set, and says how its first check went', async ($, on) => {
  const asked = engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const command = `gh issue list --repo octo/site --state open --limit 100 --json number --jq ".[].number" ${'# '.padEnd(400, 'x')}`
  const r = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { 'new issues': { command } } } as never)
  // Every character of what will run unattended, however long
  expect(asked.asked[0]).toBe(`Change the goal "Unsubscribe"?\n• New watch "new issues": every 5 min this command runs on your computer, and a run starts when it prints a line it hasn't before: ${command}`)
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', watches: { 'new issues': { command } } })
  expect(String(r.result)).toContain('Watch "new issues": works: 3 items there now; a run starts when a new one appears.')

  // goal_detail lists it, and changing or removing it says so
  expect(String((await $.tool.call({ tool: 'mcp__quarterdeck-goals__goal_detail', goal: 'unsub' } as never)).result)).toContain('- new issues: every 5 min, runs gh issue list')
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { 'new issues': { command: 'gh pr list', every_minutes: 15 }, old: null } } as never)
  expect(asked.asked[1]).toBe('Change the goal "Unsubscribe"?\n• Watch changed "new issues": every 15 min this command runs on your computer, and a run starts when it prints a line it hasn\'t before: gh pr list\n• Watch removed: old')
  // A watch on a state says it fires when its output changes, and passes the mode through
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { tree: { command: 'git describe --always --dirty', fires: 'change' } } } as never)
  expect(asked.asked[2]).toBe('Change the goal "Unsubscribe"?\n• New watch "tree": every 5 min this command runs on your computer, and a run starts when its output changes: git describe --always --dirty')
  expect(fake.of('update_goal')[2]?.input).toEqual({ goal_id: 'g1', watches: { tree: { command: 'git describe --always --dirty', fires: 'change' } } })
})

test('update_goal shows a tool watch\'s tool and whole input before it is set', async ($, on) => {
  const asked = engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const watch = { tool: 'mcp__claude_ai_Gmail__search_threads', input: { query: 'is:unread in:inbox', view: 'THREAD_VIEW_IDS_ONLY' }, every_minutes: 10 }
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { 'new mail': watch } } as never)
  expect(asked.asked[0]).toBe('Change the goal "Unsubscribe"?\n• New watch "new mail": every 10 min this tool is called without asking you, and a run starts when its answer has something it hasn\'t before: mcp__claude_ai_Gmail__search_threads {"query":"is:unread in:inbox","view":"THREAD_VIEW_IDS_ONLY"}')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', watches: { 'new mail': watch } })
})

test('a goal shows its watches when expanded, and one that cannot check keeps its card', async ($, on) => {
  engine(on)
  const watch = (failing: boolean) => [{ name: 'new issues', every_minutes: 5, runs: 'gh issue list', last_fired_at: failing ? null : '2026-11-07T07:00:00Z', failing, error: failing ? 'Exit code 4: gh: not logged in' : null }]
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Issues', watches: watch(false) }),
    goal({ id: 'g2', name: 'Pulls', watches: watch(true) }),
    goal({ id: 'g3', name: 'Tree', watches: [{ name: 'working tree', every_minutes: 1, fires: 'change', runs: 'git describe --always --dirty', last_fired_at: null, failing: false, error: null }] }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Working: one quiet line until expanded
  expect(await ui.find({ key: 'pause-g1' })).toBeUndefined()
  await ui.press({ key: 'toggle-g1' })
  expect(await ui.find({ type: 'Text', text: /Also runs when "new issues" sees something new \(checked every 5 min, last .* ago\)/ })).toBeDefined()
  // Failing: the card stays, and says so
  expect(await ui.find({ key: 'pause-g2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^a watch can't check: expand the goal to see why$/ })).toBeDefined()
  await ui.press({ key: 'toggle-g2' })
  expect(await ui.find({ type: 'Text', text: /can't check: Exit code 4: gh: not logged in/ })).toBeDefined()
  // A watch on a state runs when it changes
  await ui.press({ key: 'toggle-g3' })
  expect(await ui.find({ type: 'Text', text: /^Also runs when "working tree" changes \(checked every 1 min\)$/ })).toBeDefined()
  await ui.unmount()
})

test('while the usage limit holds runs, the pane says so', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], { hold: { until: '2026-11-07T20:10:00Z', reason: "You've hit your 5-hour limit" } })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /on hold until/ }))?.text).toContain('the usage limit is reached')
  await ui.unmount()
})

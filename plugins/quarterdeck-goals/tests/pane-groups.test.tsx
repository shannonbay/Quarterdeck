import { expect, test } from 'claude-code/testing'

import { engine, fakeQuarterdeck, goal, PANE, proposal, START } from './fixtures'

test('goals in several folders are grouped: this folder open first, the others one coloured line (#207)', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Fixer', working_dir: '/work/project' }),
    goal({ id: 'g2', name: 'Other fixer', working_dir: '/work/other', needs_you: [proposal('21', 'Open a PR')] }),
    goal({ id: 'g3', name: 'Quiet one', working_dir: '/work/third' }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'group-/work/project' }))?.props.label).toBe('▾ project')
  expect((await ui.find({ key: 'toggle-g1' }))?.props.hotkey).toBe('1')
  // A collapsed group hides its goals, so neither the Needs you key nor its card shows
  expect(await ui.find({ key: 'toggle-g2' })).toBeUndefined()
  expect(await ui.find({ key: 'approve-g2/21' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /other · 1 goal · 1 to approve/ }))?.props.color).toBe('yellow')
  expect((await ui.find({ key: 'group-toggle-/work/other' }))?.props.hotkey).toBe('2')
  const third = await ui.find({ key: 'group-toggle-/work/third' })
  expect(third?.props.label).toBe('▸ third · 1 goal')
  expect(third?.props.hotkey).toBeUndefined()

  await ui.press({ key: 'group-toggle-/work/other' })
  expect((await ui.find({ key: 'group-/work/other' }))?.props.label).toBe('▾ other')
  expect((await ui.find({ key: 'approve-g2/21' }))?.props.hotkey).toBe('a')

  await ui.press({ key: 'group-/work/project' })
  expect(await ui.find({ key: 'toggle-g1' })).toBeUndefined()
  await ui.unmount()
})

test('goals in one folder show the flat list with no group header (#207)', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Fixer', working_dir: '/work/project' }),
    goal({ id: 'g2', name: 'Reviewer', working_dir: '/work/project/' }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'group-/work/project' })).toBeUndefined()
  expect((await ui.find({ key: 'toggle-g1' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 'toggle-g2' }))?.props.hotkey).toBe('2')
  await ui.unmount()
})

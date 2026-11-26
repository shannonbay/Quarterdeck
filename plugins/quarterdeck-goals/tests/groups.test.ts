import { expect, test } from 'claude-code/testing'

import { groupGoals, groupSummary, normalizeDir, toCard } from '../hooks/model'
import { goal, proposal, question } from './fixtures'

const card = (over: Parameters<typeof goal>[0] & { working_dir?: string }) => toCard({ ...goal(over), open_item_count: over.open_items?.length ?? 0 })
const BS = String.fromCharCode(92)
const failedRun = { id: 'r1', status: 'failed', trigger: 'schedule', summary: null, started_at: '2026-11-07T08:00:00Z', ended_at: '2026-11-07T08:01:00Z' }

test('toCard carries the folder, null from an older server', async () => {
  expect(card({ id: 'g1', name: 'A', working_dir: 'C:\\Work\\Repo' }).workingDir).toBe('C:\\Work\\Repo')
  expect(card({ id: 'g2', name: 'B' }).workingDir).toBe(null)
})

test('normalizeDir matches slashes, case on Windows and a trailing separator', async () => {
  expect(normalizeDir(['C:', 'Users', 'Me', 'Repo', ''].join(BS))).toBe(normalizeDir('c:/users/me/repo'))
  expect(normalizeDir('C:' + BS)).toBe('c:/')
  expect(normalizeDir('/home/me/Repo/')).toBe('/home/me/Repo')
  expect(normalizeDir('/home/me/Repo')).not.toBe(normalizeDir('/home/me/repo'))
  expect(normalizeDir('/')).toBe('/')
})

test('groupGoals puts the session folder first, then groups needing you, then the rest by label', async () => {
  const goals = [
    card({ id: 'a1', name: 'Alpha one', working_dir: 'C:\\code\\Alpha' }),
    card({ id: 'z1', name: 'Zed one', working_dir: 'C:\\code\\Zed', needs_you: [proposal('i1', 'Send it')] }),
    card({ id: 'h1', name: 'Home one', working_dir: 'c:/Code/Home/' }),
    card({ id: 'b1', name: 'Beta one', working_dir: 'C:\\code\\beta' }),
    card({ id: 'h2', name: 'Home two', working_dir: 'C:\\code\\Home', needs_you: [proposal('i2', 'Do it')] }),
  ]
  const groups = groupGoals(goals, 'C:\\Code\\Home')
  expect(groups.map((g) => g.label)).toEqual(['Home', 'Zed', 'Alpha', 'beta'])
  expect(groups[0].current).toBe(true)
  expect(groups.slice(1).some((g) => g.current)).toBe(false)
  // inside a group, the one needing attention first, then the rest as given
  expect(groups[0].goals.map((g) => g.id)).toEqual(['h2', 'h1'])
  expect(groups[0].key).toBe('c:/code/home')
})

test('groupGoals puts a goal with no folder in the session group', async () => {
  const groups = groupGoals([card({ id: 'old', name: 'Old' }), card({ id: 'n', name: 'New', working_dir: '/home/me/repo' })], '/home/me/repo')
  expect(groups).toHaveLength(1)
  expect(groups[0].goals.map((g) => g.id)).toEqual(['old', 'n'])
})

test('groupGoals adds the parent folder when two base names are the same', async () => {
  const groups = groupGoals([
    card({ id: 'w', name: 'W', working_dir: '/home/me/work/Quarterdeck' }),
    card({ id: 'f', name: 'F', working_dir: '/home/me/forks/Quarterdeck' }),
    card({ id: 'o', name: 'O', working_dir: '/home/me/Other' }),
  ], '/home/me/Other')
  expect(groups.map((g) => g.label)).toEqual(['Other', 'forks/Quarterdeck', 'work/Quarterdeck'])
})

test('one folder gives one group', async () => {
  const groups = groupGoals([card({ id: 'a', name: 'A', working_dir: '/r' }), card({ id: 'b', name: 'B', working_dir: '/r' })], '/elsewhere')
  expect(groups).toHaveLength(1)
  expect(groups[0].current).toBe(false)
})

test('groupSummary counts approvals, questions, running and failing', async () => {
  const quiet = groupSummary({ label: 'Repo', goals: [card({ id: 'a', name: 'A' })] })
  expect(quiet).toEqual({ text: 'Repo · 1 goal', needsYou: false })
  const busy = groupSummary({ label: 'OtherRepo', goals: [
    card({ id: 'a', name: 'A', needs_you: [proposal('i1', 'One'), proposal('i2', 'Two'), question('q1', 'Which?')] }),
    card({ id: 'b', name: 'B', open_run: { id: 'r2', status: 'running' }, activity: { state: 'running', text: 'Working', at: null } }),
    card({ id: 'c', name: 'C', runs: [failedRun] }),
    card({ id: 'd', name: 'D' }),
    card({ id: 'e', name: 'E' }),
  ] })
  expect(busy.text).toBe('OtherRepo · 5 goals · 2 to approve · 1 question · 1 running · 1 failing')
  expect(busy.needsYou).toBe(true)
  const running = groupSummary({ label: 'R', goals: [card({ id: 'b', name: 'B', open_run: { id: 'r2', status: 'running' }, activity: { state: 'running', text: 'Working', at: null } })] })
  expect(running).toEqual({ text: 'R · 1 goal · 1 running', needsYou: false })
})

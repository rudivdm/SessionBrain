// The caption over the ink: what Claude is doing now, from the board.

import { expect, test } from 'bun:test'

import { caption } from '../web/caption'
import type { Board, Entry } from '../web/lot-map/types'
import { setupFrom } from '../web/lot-map/map'

const { t } = setupFrom({ language: 'en' })
const entry = (over: Partial<Entry>): Entry => ({ id: Math.random().toString(36), station: 'model', label: 'opus 5.5 · step 3', from: 'core', startedAt: 0, status: 'ok', ...over })
const board = (entries: Entry[]): Board => ({ entries, counts: {} })
const now = 100_000

test('a running tool leads, with its activity and how long it has run', () => {
  const c = caption({ board: board([entry({ status: 'run', startedAt: 90_000 }), entry({ station: 'shell', label: 'Run the tests', status: 'run', startedAt: 92_000 })]), t, now, feed: 'live' })
  expect(c).toMatchObject({ title: 'Run the tests', station: 'shell', state: 'running' })
  expect(c.detail).toContain('Shell')
  expect(c.detail).toContain('8.0')
  expect(c.detail).toContain('1 more running')
})

test('only the model at work reads as thinking', () => {
  const c = caption({ board: board([entry({ status: 'run', startedAt: 95_000 })]), t, now, feed: 'live' })
  expect(c).toMatchObject({ title: 'Thinking', station: 'model', state: 'thinking' })
})

test('a call whose end was never written, hours ago, does not lead', () => {
  const stale = entry({ station: 'agents', label: 'old subagent', status: 'run', startedAt: now - 7 * 3600_000 })
  const c = caption({ board: board([stale, entry({ station: 'files', label: 'Read app.ts', status: 'run', startedAt: 99_000 })]), t, now, feed: 'live' })
  expect(c.title).toBe('Read app.ts')
  expect(c.detail).not.toContain('more running')
})

test('after the answer it says so, and waits', () => {
  const c = caption({ board: board([entry({ station: 'you', label: 'answer', mark: 'done', startedAt: 97_000 })]), t, now, feed: 'live' })
  expect(c).toMatchObject({ title: 'Answer ready', state: 'answered' })
})

test('an ended session says so, with what it did last', () => {
  const c = caption({ board: board([entry({ station: 'shell', label: 'Deploy' })]), t, now, feed: 'ended' })
  expect(c).toMatchObject({ title: 'Session ended', state: 'ended' })
  expect(c.detail).toContain('Deploy')
})

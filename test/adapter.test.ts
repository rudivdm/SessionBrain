// The adapter: transcript records in, lot-map's board out. First small made-up sessions, one rule
// each; then every real transcript on this machine, folded and drawn, checked for what must hold.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Adapter, contextPercent } from '../web/adapter'
import type { Rec } from '../web/adapter'
import { drawMap, setupFrom } from '../web/lot-map/map'

const setup = setupFrom({ language: 'en' })
const fold = (recs: Rec[]) => {
  const a = new Adapter(setup)
  a.add(recs)
  return a.board
}
const tool = (id: string, name: string, input: Record<string, unknown> = {}) => ({ id, name, input })
const step = (at: number, req: string, tools: ReturnType<typeof tool>[] = [], extra: Partial<Extract<Rec, { k: 'step' }>> = {}): Rec => ({ k: 'step', at, model: 'claude-opus-5-5', req, tokens: 40_000, tools, ...extra })
const results = (at: number, ...rs: { id: string; err?: boolean; block?: boolean; task?: Record<string, unknown> }[]): Rec => ({ k: 'results', at, results: rs })

describe('one turn', () => {
  const board = fold([
    { k: 'prompt', at: 1000 },
    step(3000, 'r1', [tool('t1', 'Read', { file_path: '/p/src/app.ts' }), tool('t2', 'Bash', { command: 'bun test --secret-flag', description: 'Run the tests' })]),
    results(3500, { id: 't1' }),
    results(5000, { id: 't2', err: true }),
    step(6000, 'r2', [], { stop: 'end_turn' }),
    { k: 'end', at: 6100 },
  ])

  test('the message, the model steps, the calls and the answer, in order', () => {
    expect(board.entries.map(e => [e.station, e.status])).toEqual([
      ['you', 'ok'],
      ['model', 'ok'],
      ['files', 'ok'],
      ['shell', 'err'],
      ['model', 'ok'],
      ['you', 'ok'],
    ])
    expect(board.entries.at(-1)?.mark).toBe('done')
  })

  test('times come from the transcript', () => {
    const model = board.entries[1]!
    expect([model.startedAt, model.endedAt]).toEqual([1000, 3000])
    const shell = board.entries[3]!
    expect([shell.startedAt, shell.endedAt]).toEqual([3000, 5000])
    expect(board.entries[4]?.startedAt).toBe(5000)
  })

  test('labels: the file, the description (never the command), the model and step', () => {
    expect(board.entries[2]?.label).toContain('app.ts')
    expect(board.entries[3]?.label).toBe('Run the tests')
    expect(JSON.stringify(board)).not.toContain('secret-flag')
    expect(board.entries[1]?.label).toBe('opus 5.5 · step 1')
    expect(board.entries[4]?.label).toBe('opus 5.5 · step 2')
  })

  test('counts, faults, model and context', () => {
    expect(board.counts).toMatchObject({ you: 2, model: 2, files: 1, shell: 1 })
    expect(board.faults).toEqual({ shell: 1 })
    expect(board.model).toBe('claude-opus-5-5')
    expect(board.step).toBe(2)
    expect(board.context).toBe(20)
  })

  test('the answer is marked once, though both the last message and the turn end say so', () => {
    expect(board.entries.filter(e => e.mark === 'done')).toHaveLength(1)
  })
})

test('while the model works, a running step shows; when its message lands it is done', () => {
  const a = new Adapter(setup)
  a.add([{ k: 'prompt', at: 1000 }])
  expect(a.board.entries.at(-1)).toMatchObject({ station: 'model', status: 'run', startedAt: 1000 })
  a.add([step(2000, 'r1', [tool('t1', 'Grep')])])
  expect(a.board.entries.filter(e => e.status === 'run').map(e => e.station)).toEqual(['files'])
  a.add([results(2500, { id: 't1' })])
  expect(a.board.entries.at(-1)).toMatchObject({ station: 'model', status: 'run', startedAt: 2500 })
})

test('one model message written in several records is one step, and its calls are counted once', () => {
  const board = fold([{ k: 'prompt', at: 1 }, step(2, 'r1', [tool('t1', 'Read', { file_path: '/a' })]), step(3, 'r1', [tool('t2', 'Read', { file_path: '/b' })]), step(3, 'r1', [tool('t2', 'Read', { file_path: '/b' })])])
  expect(board.counts).toMatchObject({ model: 1, files: 2 })
})

test('a refused call lights hooks and is drawn as blocked', () => {
  const board = fold([{ k: 'prompt', at: 1 }, step(2, 'r1', [tool('t1', 'Bash', { description: 'Install it' })]), results(3, { id: 't1', err: true, block: true })])
  const hooks = board.entries.find(e => e.station === 'hooks')
  expect(hooks).toMatchObject({ status: 'block' })
  expect(board.entries.find(e => e.station === 'shell')?.status).toBe('block')
  expect(board.faults).toMatchObject({ hooks: 1, shell: 1 })
})

test('a background task stays running until its notice says how it ended', () => {
  const a = new Adapter(setup)
  a.add([{ k: 'prompt', at: 1 }, step(2, 'r1', [tool('t1', 'Bash', { description: 'Build', run_in_background: true })]), results(3, { id: 't1', task: { backgroundTaskId: 'bg42' } }), step(4, 'r2', [], { stop: 'end_turn' }), { k: 'end', at: 5 }])
  const build = () => a.board.entries.find(e => e.label === 'Build')
  expect(build()).toMatchObject({ status: 'run', task: 'bg42' })
  a.add([{ k: 'prompt', at: 9, notice: '<task-notification>\n<task-id>bg42</task-id>\n<status>failed</status>' }])
  expect(build()).toMatchObject({ status: 'err', endedAt: 9 })
  // A notice is not the person writing.
  expect(a.board.entries.filter(e => e.station === 'you' && e.label === setup.t.newMessage)).toHaveLength(1)
})

test('a subagent works on the agents side, joins the crew, and leaves it when done', () => {
  const a = new Adapter(setup)
  a.add([
    { k: 'prompt', at: 1 },
    step(2, 'r1', [tool('t1', 'Agent', { description: 'Map the code', subagent_type: 'scout' })]),
    { k: 'step', at: 3, agent: 'a1', model: 'claude-haiku-5-5', req: 'q1', tools: [tool('s1', 'Grep')] },
  ])
  expect(a.board.agents).toEqual(['a1'])
  expect(a.board.entries.at(-1)).toMatchObject({ station: 'files', from: 'agents', agentId: 'a1', status: 'run' })
  expect(a.board.model).toBe('claude-opus-5-5')
  a.add([{ k: 'results', at: 4, agent: 'a1', results: [{ id: 's1' }] }, { k: 'step', at: 5, agent: 'a1', model: 'claude-haiku-5-5', req: 'q2', stop: 'end_turn' }])
  expect(a.board.agents).toEqual([])
  a.add([results(6, { id: 't1', task: { status: 'completed', agentId: 'a1' } })])
  expect(a.board.entries.filter(e => e.status === 'run').map(e => e.station)).toEqual(['model'])
})

test('a model change is marked on the map', () => {
  const board = fold([{ k: 'prompt', at: 1 }, step(2, 'r1'), step(3, 'r2', [], { model: 'claude-haiku-5-5' })])
  expect(board.entries.find(e => e.mark === 'switch')?.label).toBe('opus 5.5 → haiku 5.5')
  expect(board.switchedAt).toBe(3)
})

test('a stopped turn reads as stopped, and its calls stop with it', () => {
  const board = fold([{ k: 'prompt', at: 1 }, step(2, 'r1', [tool('t1', 'Bash', { description: 'Long job' })]), { k: 'abort', at: 3 }])
  expect(board.entries.at(-1)).toMatchObject({ station: 'you', status: 'err', label: setup.t.turnAborted })
  expect(board.entries.filter(e => e.status === 'run')).toEqual([])
})

test('memory records a hook brought in, and a compaction', () => {
  // Memory records are told apart only when the hookRecords option is on (lot-map's default is off).
  const a = new Adapter(setupFrom({ language: 'en', hookRecords: true }))
  a.add([{ k: 'context', at: 1, event: 'UserPromptSubmit', text: 'Relevant memories: [#12] [note #40]' }, { k: 'compact', at: 2 }])
  const board = a.board
  expect(board.entries.map(e => e.station)).toEqual(['hooks', 'memory', 'model'])
  expect(board.pushed).toBe(1)
})

test('rows are capped at lot-map’s 80, background tasks kept beside them', () => {
  const recs: Rec[] = [{ k: 'prompt', at: 1 }, step(2, 'r0', [tool('bg', 'Bash', { description: 'Watch' })]), results(3, { id: 'bg', task: { backgroundTaskId: 'w1' } })]
  for (let i = 1; i <= 200; i++) recs.push(step(10 + i * 2, `r${i}`, [tool(`t${i}`, 'Read', { file_path: `/f${i}` })]), results(11 + i * 2, { id: `t${i}` }))
  const board = fold(recs)
  expect(board.entries.length).toBeLessThanOrEqual(81)
  expect(board.entries.some(e => e.task === 'w1' && e.status === 'run')).toBe(true)
})

test('records it cannot read are skipped, never fatal', () => {
  const a = new Adapter(setup)
  a.add([{ k: 'results', at: 1, results: null } as unknown as Rec, { k: 'weird' } as unknown as Rec, { k: 'prompt', at: 2 }])
  expect(a.board.entries[0]?.station).toBe('you')
})

test('another language builds the same map with other words', () => {
  const a = new Adapter(setup)
  a.add([{ k: 'prompt', at: 1 }, step(2, 'r1')])
  const b = a.rebuild(setupFrom({ language: 'ru' }))
  expect(b.board.entries.map(e => e.station)).toEqual(a.board.entries.map(e => e.station))
  expect(b.board.entries[0]?.label).not.toBe(a.board.entries[0]?.label)
})

test('the context gauge', () => {
  expect(contextPercent(100_000, false)).toBe(50)
  expect(contextPercent(100_000, true)).toBe(10)
  expect(contextPercent(300_000, false)).toBe(30)
})

// ---------------------------------------------------------------------------------------------
// Every real transcript on this machine (read-only), through the real hub binary's slimming.

const APP = process.env.SESSIONBRAIN_HUB ?? join(import.meta.dir, '..', 'app', 'target', 'release', 'sessionbrain-app')
const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')

function transcripts(): string[] {
  if (!existsSync(PROJECTS) || !existsSync(APP)) return []
  const out: string[] = []
  for (const dir of readdirSync(PROJECTS)) {
    const full = join(PROJECTS, dir)
    if (!statSync(full).isDirectory()) continue
    for (const f of readdirSync(full)) if (f.endsWith('.jsonl')) out.push(join(full, f))
  }
  return out
}

test.skipIf(transcripts().length === 0)('every transcript on this machine folds into a sound map', async () => {
  const files = transcripts()
  let records = 0
  for (const file of files) {
    const run = Bun.spawnSync([APP, 'records', file])
    expect(run.exitCode).toBe(0)
    const recs = run.stdout.toString().split('\n').filter(Boolean).map(l => JSON.parse(l) as Rec)
    records += recs.length
    const a = new Adapter(setup)
    a.add(recs)
    const b = a.board
    for (const e of b.entries) {
      expect(['run', 'ok', 'err', 'block']).toContain(e.status)
      if (e.endedAt !== undefined) expect(e.endedAt).toBeGreaterThanOrEqual(e.startedAt)
      expect(Number.isFinite(e.startedAt)).toBe(true)
    }
    expect(b.entries.length).toBeLessThanOrEqual(80 + b.entries.filter(e => e.task !== undefined).length)
    expect((b.agents ?? []).length).toBeLessThanOrEqual(12)
    if (b.context !== undefined) expect(b.context).toBeGreaterThanOrEqual(0)
    const last = recs.at(-1)
    if (last?.k === 'end' && last.agent === undefined) {
      // The session's last turn is over: the core has nothing running.
      expect(b.entries.filter(e => e.status === 'run' && e.from === 'core' && e.task === undefined)).toEqual([])
    }
    const svg = drawMap(b, (last?.at ?? 0) + 1000, setup)
    expect(svg.startsWith('<svg')).toBe(true)
  }
  console.log(`folded ${files.length} transcripts, ${records} records`)
}, 120_000)

test('records arriving out of time order (main transcript, then a subagent) are folded in time order', () => {
  const sub = (at: number, req: string): Rec => ({ ...step(at, req), agent: 'a1' }) as Rec
  // The first batch of a session: the main transcript's records, then an old subagent's.
  const board = fold([{ k: 'prompt', at: 5000 }, step(6000, 'r2', [tool('t9', 'Read', { file_path: '/new' })]), sub(1000, 's1'), sub(2000, 's2')])
  const starts = board.entries.map(e => e.startedAt)
  expect(starts).toEqual([...starts].sort((x, y) => x - y))
  expect(board.entries.at(-1)?.label).toContain('new')
})

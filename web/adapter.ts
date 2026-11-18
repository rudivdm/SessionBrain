// Turns a session's transcript (the slim records the hub passes on; see app/src/transcript.rs) into
// lot-map's board, the same board lot-map's own mod builds from live events. Every rule here
// mirrors one of lot-map's reducers; the times are the transcript's own, so a page opened in the
// middle of a session shows how long things really took.

import type { Board, Entry, StationId, Status } from './lot-map/types'
import { classify, clean, memoryIds, shortModel, taskNotice, taskOf } from './lot-map/map'
import type { Setup } from './lot-map/map'

type Tool = { id: string; name: string; input?: Record<string, unknown> }
type Result = { id: string; err?: boolean; block?: boolean; task?: Record<string, unknown> }

export type Rec =
  | { k: 'step'; at: number; agent?: string; model: string; req: string; tokens?: number; wide?: boolean; stop?: string; tools?: Tool[] }
  | { k: 'results'; at: number; agent?: string; results: Result[] }
  | { k: 'prompt'; at: number; agent?: string; notice?: string }
  | { k: 'abort'; at: number; agent?: string }
  | { k: 'end'; at: number; agent?: string }
  | { k: 'compact'; at: number; agent?: string }
  | { k: 'context'; at: number; agent?: string; event: string; text: string }

const KEEP = 80
const CREW = 12
/** The main loop's key; a subagent's loop is keyed by its id. */
const MAIN = ''

/** How full the context is, 0 to 100 (the hub reckons it the same way). */
export function contextPercent(tokens: number, wide: boolean): number {
  const window = wide || tokens > 200_000 ? 1_000_000 : 200_000
  return Math.round((tokens / window) * 1000) / 10
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'
const oneMore = (faults: Board['faults'], station: StationId): Board['faults'] => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })

/** The newest rows, and beside them every background task still going, however long ago it started. */
const kept = (entries: Entry[]): Entry[] => {
  const from = entries.length - KEEP
  return from <= 0 ? entries : entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
}

type Start = {
  station: StationId
  label: string
  at: number
  from?: Entry['from']
  status?: Status
  endedAt?: number
  agentId?: string
  mark?: Entry['mark']
  uncounted?: boolean
}

export class Adapter {
  board: Board = { entries: [], counts: {} }
  private seq = 0
  /** A tool call's id → its row and the loop that made it. */
  private calls = new Map<string, { entry: string; loop: string; tool: string }>()
  /** Per loop: the request the last model message belonged to, the step number, the row of the model working now. */
  private lastReq = new Map<string, string>()
  private steps = new Map<string, number>()
  private thinking = new Map<string, string>()
  private lastModel: string | undefined
  private wide = false
  /** Whether the main loop is inside a turn (the person wrote and the answer is not in yet). */
  private turnOpen = false

  /** Every record taken, to build the board again in another language. As many as the hub keeps. */
  private all: Rec[] = []

  constructor(private setup: Setup) {}

  get setupUsed(): Setup {
    return this.setup
  }

  /** The same records folded again with other display options. */
  rebuild(setup: Setup): Adapter {
    const next = new Adapter(setup)
    next.add(this.all)
    return next
  }

  add(records: readonly Rec[]): void {
    // In time order: a session's first batch has the main transcript's records and then each
    // subagent's, so without this a subagent's old steps would land after the newest work.
    const ordered = [...records].sort((x, y) => x.at - y.at)
    this.all.push(...ordered)
    if (this.all.length > 3000) this.all.splice(0, this.all.length - 3000)
    for (const r of ordered) {
      try {
        this.one(r)
      } catch {
        // A record shaped other than expected is skipped; the map goes on.
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // lot-map's reducers, timed by the records

  private begin(s: Start): string {
    const entry: Entry = {
      id: `w${++this.seq}`,
      station: s.station,
      label: clean(s.label),
      from: s.from ?? 'core',
      startedAt: s.at,
      status: s.status ?? 'run',
      ...(s.status !== undefined ? { endedAt: s.endedAt ?? s.at } : {}),
      ...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
      ...(s.mark !== undefined ? { mark: s.mark } : {}),
    }
    const b = this.board
    this.board = {
      ...b,
      entries: kept([...b.entries, entry]),
      counts: s.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
      ...(entry.station === 'memory' && entry.from === 'inbound' && !s.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
      ...(isFault(entry.status) && entry.station !== 'you' ? { faults: oneMore(b.faults, entry.station) } : {}),
      ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId) ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) } : {}),
    }
    return entry.id
  }

  private finish(id: string | undefined, status: Status, at: number, change: Partial<Entry> = {}): void {
    if (id === undefined) return
    const b = this.board
    const open = b.entries.find(e => e.id === id && e.status === 'run')
    if (open === undefined) return
    this.board = {
      ...b,
      entries: b.entries.map(e => (e === open ? { ...e, ...change, status, endedAt: Math.max(at, e.startedAt) } : e)),
      ...(isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
    }
  }

  private settle(task: string, status: Status, at: number): void {
    const open = this.board.entries.find(e => e.task === task && e.status === 'run')
    if (open !== undefined) this.finish(open.id, status, at)
  }

  /** A subagent is done: it leaves the crew and whatever it had running stops. */
  private agentDone(agentId: string, at: number): void {
    this.thinking.delete(agentId)
    this.board = {
      ...this.board,
      agents: (this.board.agents ?? []).filter(id => id !== agentId),
      entries: this.board.entries.map(x => (x.status === 'run' && (x.agentId === agentId || x.task === agentId) ? { ...x, status: 'ok' as const, endedAt: at } : x)),
    }
  }

  /** The answer is in (or the turn was stopped): the person's station says so and the core's work stops. */
  private turnDone(at: number, aborted: boolean): void {
    if (!this.turnOpen) return
    this.turnOpen = false
    const { t } = this.setup
    this.thinking.delete(MAIN)
    this.board = {
      ...this.board,
      entries: this.board.entries.map(x => (x.status === 'run' && x.from === 'core' && x.task === undefined ? { ...x, status: 'ok' as const, endedAt: at } : x)),
    }
    this.begin({ station: 'you', label: aborted ? t.turnAborted : t.answerReady, status: aborted ? 'err' : 'ok', at, ...(aborted ? {} : { mark: 'done' as const }) })
  }

  /** The model is called (again) for a loop: a running row until its message lands. */
  private think(loop: string, at: number): void {
    if (this.thinking.has(loop)) return
    const { t } = this.setup
    const n = (this.steps.get(loop) ?? 0) + 1
    const model = this.lastModel === undefined ? '' : `${shortModel(this.lastModel)} · `
    const isMain = loop === MAIN
    this.thinking.set(loop, this.begin({
      station: 'model',
      label: `${model}${t.step(n)}${isMain ? '' : ` · ${t.subagent}`}`,
      from: isMain ? 'core' : 'agents',
      at,
      ...(isMain ? {} : { agentId: loop }),
    }))
  }

  private noteContext(text: string, when: string, at: number): void {
    const { t } = this.setup
    if (text.trim() === '') return
    const ids = this.setup.hookRecords ? memoryIds(text) : []
    if (ids.length === 0) {
      this.begin({ station: 'hooks', label: t.addedContext(when), status: 'ok', at })
      return
    }
    this.begin({ station: 'hooks', label: t.addedMemory(when), status: 'ok', at })
    const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ')
    this.begin({ station: 'memory', label: t.records(ids.length, `${shown}${ids.length > 6 ? ' …' : ''}`), from: 'inbound', status: 'ok', at })
  }

  // ------------------------------------------------------------------------------------------

  private one(r: Rec): void {
    const { t } = this.setup
    const loop = r.agent ?? MAIN
    const isMain = loop === MAIN
    switch (r.k) {
      case 'prompt': {
        if (!isMain) return
        const notice = r.notice === undefined ? undefined : taskNotice(r.notice)
        if (notice !== undefined) {
          if (notice.status !== undefined) this.settle(notice.id, notice.status, r.at)
        } else {
          this.board = this.board.faults === undefined ? this.board : { ...this.board, faults: {} }
          this.begin({ station: 'you', label: t.newMessage, from: 'inbound', status: 'ok', at: r.at })
        }
        this.turnOpen = true
        this.steps.set(MAIN, 0)
        this.think(MAIN, r.at)
        return
      }
      case 'step': {
        const newStep = this.lastReq.get(loop) !== r.req || r.req === ''
        if (newStep) {
          this.lastReq.set(loop, r.req)
          const n = (this.steps.get(loop) ?? 0) + 1
          this.steps.set(loop, n)
          if (isMain && this.lastModel !== undefined && this.lastModel !== r.model) {
            this.begin({ station: 'model', label: `${shortModel(this.lastModel)} → ${shortModel(r.model)}`, status: 'ok', mark: 'switch', uncounted: true, at: r.at })
            this.board = { ...this.board, switchedAt: r.at }
          }
          if (isMain) {
            this.lastModel = r.model
            this.turnOpen = true
          }
          const label = `${shortModel(r.model)} · ${t.step(n)}${isMain ? '' : ` · ${t.subagent}`}`
          const running = this.thinking.get(loop)
          this.thinking.delete(loop)
          if (running !== undefined && this.board.entries.some(e => e.id === running && e.status === 'run')) {
            this.finish(running, 'ok', r.at, { label })
          } else {
            this.begin({ station: 'model', label, from: isMain ? 'core' : 'agents', status: 'ok', at: r.at, ...(isMain ? {} : { agentId: loop }) })
          }
          if (isMain) {
            if (r.wide) this.wide = true
            this.board = {
              ...this.board,
              model: r.model,
              step: n,
              ...(r.tokens !== undefined ? { context: contextPercent(r.tokens, this.wide) } : {}),
            }
          }
        }
        for (const tool of r.tools ?? []) {
          if (this.calls.has(tool.id)) continue
          const seen = classify(tool.name, tool.input ?? {}, this.setup)
          const entry = this.begin({ ...seen, at: r.at, ...(isMain ? { from: 'core' as const } : { from: 'agents' as const, agentId: loop }) })
          this.calls.set(tool.id, { entry, loop, tool: tool.name })
        }
        if ((r.tools ?? []).length === 0 && r.stop === 'end_turn') {
          if (isMain) this.turnDone(r.at, false)
          else this.agentDone(loop, r.at)
        }
        return
      }
      case 'results': {
        for (const res of r.results) {
          const call = this.calls.get(res.id)
          if (call === undefined) continue
          this.calls.delete(res.id)
          if (res.block) {
            this.begin({ station: 'hooks', label: t.stopped(call.tool), status: 'block', at: r.at })
          }
          const task = res.block || res.err ? undefined : taskOf(res.task)
          if (task !== undefined) {
            this.board = { ...this.board, entries: this.board.entries.map(e => (e.id === call.entry && e.status === 'run' ? { ...e, task } : e)) }
          } else {
            this.finish(call.entry, res.block ? 'block' : res.err ? 'err' : 'ok', r.at)
          }
          // A subagent that ran in the foreground is done once its call returns.
          const agentId = res.task?.agentId
          if (typeof agentId === 'string' && task === undefined) this.agentDone(agentId, r.at)
          // The loop's calls are all back: the model is called again.
          if (![...this.calls.values()].some(c => c.loop === call.loop) && (call.loop !== MAIN || this.turnOpen)) this.think(call.loop, r.at)
        }
        return
      }
      case 'abort': {
        if (!isMain) return
        for (const [id, c] of this.calls) if (c.loop === MAIN) this.calls.delete(id)
        this.turnDone(r.at, true)
        return
      }
      case 'end': {
        if (isMain) this.turnDone(r.at, false)
        return
      }
      case 'compact': {
        if (!isMain) return
        this.begin({ station: 'model', label: t.compacting, status: 'ok', at: r.at })
        const { context: _, ...rest } = this.board
        this.board = rest
        return
      }
      case 'context': {
        if (r.event === 'SessionStart') this.noteContext(r.text, t.atStart, r.at)
        else if (r.event === 'UserPromptSubmit') this.noteContext(r.text, t.toMessage, r.at)
        return
      }
    }
  }
}

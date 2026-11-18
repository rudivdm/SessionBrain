// The caption over the ink: one sentence saying what Claude is doing now, and a line under it saying
// where and for how long. A tool call says more than a model step, so a running tool leads.

import type { Board, Entry, StationId } from './lot-map/types'
import { formatMs } from './lot-map/map'
import type { Strings } from './lot-map/text'

/** How long a call may run before the caption takes it for one whose end was never written. */
const STALE_MS = 6 * 3600_000

export type Caption = {
  /** The sentence: what is happening. */
  title: string
  /** The line under it: where, for how long, what else runs. */
  detail: string
  /** The activity it is about, for its colour. */
  station?: StationId
  state: 'running' | 'thinking' | 'answered' | 'idle' | 'ended' | 'waiting'
}

export type CaptionInput = {
  board: Board
  t: Strings
  now: number
  /** The session's state from the hub. */
  feed: 'live' | 'nofeed' | 'ended'
}

export function caption({ board, t, now, feed }: CaptionInput): Caption {
  const entries = board.entries
  if (feed === 'nofeed') return { title: 'Starting up', detail: 'Waiting for the session to write its first message', state: 'waiting' }

  // What runs, newest first. A call 'running' for hours is one whose end was never written: left out.
  const running = entries.filter(e => e.status === 'run' && now - e.startedAt < STALE_MS).sort((x, y) => y.startedAt - x.startedAt)
  const newest = running[0]
  // A tool call says more than the model step around it, so a tool started with or after the newest step leads.
  const tool = running.find(e => e.station !== 'model')
  const lead: Entry | undefined = tool !== undefined && newest !== undefined && tool.startedAt >= newest.startedAt - 1000 ? tool : newest
  const last = entries[entries.length - 1]

  if (feed === 'ended') {
    return { title: 'Session ended', detail: last === undefined ? '' : `Last: ${t.stations[last.station]} · ${last.label}`, station: last?.station, state: 'ended' }
  }

  if (lead !== undefined) {
    const others = running.length - 1
    const elapsed = formatMs(Math.max(0, now - lead.startedAt), t)
    if (lead.station === 'model') {
      // Only the model is at work: Claude is thinking, on the step the label names.
      return { title: 'Thinking', detail: [lead.label, elapsed].join(' · '), station: 'model', state: 'thinking' }
    }
    const parts = [t.stations[lead.station], elapsed]
    if (others > 0) parts.push(`${others} more running`)
    return { title: lead.label, detail: parts.join(' · '), station: lead.station, state: 'running' }
  }

  if (last?.mark === 'done') {
    return { title: 'Answer ready', detail: `Finished ${formatMs(Math.max(0, now - last.startedAt), t)} ago · waiting for you`, state: 'answered' }
  }
  if (last === undefined) return { title: t.idle, detail: t.nothingYet, state: 'idle' }
  return { title: t.idle, detail: `Last: ${t.stations[last.station]} · ${last.label}`, station: last.station, state: 'idle' }
}

// What the hub tells the page about each session (the hub is written in Rust: app/src/registry.rs).

export type Summary = {
  sessionId: string
  name: string
  cwd?: string
  pid?: number
  activity?: string
  kind?: string
  startedAt?: number
  /** live: open, and its transcript is followed; nofeed: open, transcript not found yet; ended: closed. */
  feed: 'live' | 'ended' | 'nofeed'
  lastSeen?: number
  model?: string
  context?: number
  running: number
}

// The SessionBrain page: a picker of open Claude sessions, and the live view of one of them: ink that
// blooms with every call (ink.ts), a caption saying what Claude is doing (caption.ts), a timeline of
// the last minutes (timeline.ts) and the calls, all from a board the adapter builds out of the
// session's transcript. The diagram (scope.ts) is the other view, and the one used without WebGL.

import type { Board, StationId } from './lot-map/types'
import { STATIONS, describeNow, foldRows, formatMs, setupFrom } from './lot-map/map'
import type { Setup } from './lot-map/map'
import { Scope, refreshColors, stationColor } from './scope'
import { InkField } from './ink'
import type { Feed, Link } from './ink'
import { Timeline } from './timeline'
import { caption } from './caption'
import { Adapter } from './adapter'
import type { Rec } from './adapter'
import type { Summary } from './types'
import { SKINS, SKIN_LABELS, colorList, omarchySkin, paintPage } from './skins'
import type { Skin, SkinName } from './skins'

type View = { session: Summary; adapter: Adapter } | { missing: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const params = new URLSearchParams(location.search)
const sessionId = params.get('session') ?? undefined
if (params.has('embed')) document.body.classList.add('embed')
// The key came in the address only to set the cookie: take it out so it is not shown, copied or shared.
if (params.has('key')) {
  params.delete('key')
  history.replaceState(null, '', `${location.pathname}${params.size > 0 ? `?${params}` : ''}${location.hash}`)
}

// ---------------------------------------------------------------------------------------------
// Display options: the address wins, then what was set here (the ⚙ dialog).

const PREF_KEYS = ['skin', 'view', 'theme', 'language', 'layout', 'coreName'] as const
type Prefs = Partial<Record<(typeof PREF_KEYS)[number], string>>

function loadPrefs(): Prefs {
  try {
    // Options saved before SessionBrain was renamed from workLens are read too.
    return JSON.parse(localStorage.getItem('sessionbrain.prefs') ?? localStorage.getItem('worklens.prefs') ?? '{}') as Prefs
  } catch {
    return {}
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem('sessionbrain.prefs', JSON.stringify(p))
  } catch {}
}
let prefs = loadPrefs()

function pref(key: (typeof PREF_KEYS)[number]): string | undefined {
  const value = params.get(key === 'language' ? 'lang' : key) ?? prefs[key]
  return value === undefined || value === '' ? undefined : value
}

/** The Omarchy theme's colours, from the hub; fetched again now and then, so the map follows a theme change. */
let desktopColors: Record<string, string> | undefined
async function loadDesktopColors() {
  try {
    const res = await fetch('/api/desktop-colors')
    const next = res.ok ? ((await res.json()) as Record<string, string>) : undefined
    if (JSON.stringify(next) !== JSON.stringify(desktopColors)) {
      desktopColors = next
      if (pref('skin') === 'omarchy') applySkinChange()
    }
  } catch {}
}

function currentSkin(): Skin | undefined {
  const name = pref('skin') as SkinName | undefined
  if (name === undefined || name === 'classic' || !(name in SKIN_LABELS)) return undefined
  if (name === 'omarchy') return desktopColors === undefined ? undefined : omarchySkin(desktopColors)
  return SKINS[name]
}

function setupFor(): Setup {
  // The page draws the scope behind the map, so the map leaves its own background out.
  const options: Record<string, unknown> = { background: 'transparent' }
  for (const key of PREF_KEYS) {
    const value = pref(key)
    if (value !== undefined && key !== 'skin' && key !== 'view') options[key] = value
  }
  const skin = currentSkin()
  if (skin !== undefined) {
    options.theme = skin.mode
    options.colors = colorList(skin.palette)
  }
  return setupFrom(options)
}

function applyTheme(setup: Setup) {
  if (setup.theme === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', setup.theme)
  paintPage(currentSkin())
}

/** After the skin or its colours changed: repaint the page and rebuild the map in the new colours. */
function applySkinChange() {
  applyTheme(setupFor())
  if (view !== undefined && !('missing' in view)) view = { ...view, adapter: view.adapter.rebuild(setupFor()) }
  drawView()
}

// ---------------------------------------------------------------------------------------------
// Little helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className !== '') e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
const home = (path?: string) => (path ?? '').replace(/^\/home\/[^/]+/, '~')
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
const shortModel = (m?: string) => (m ?? '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)(-.*)?$/, ' $1.$2')
function feedWord(s: Summary): string {
  switch (s.feed) {
    case 'live':
      return s.activity ?? 'live'
    case 'nofeed':
      return `${s.activity ?? 'open'} · starting`
    case 'ended':
      return 'ended'
  }
}

// ---------------------------------------------------------------------------------------------
// The picker, and the session menu in the bar

let sessions: Summary[] = []

function renderSessions() {
  const pick = $<HTMLSelectElement>('pick')
  pick.replaceChildren()
  if (sessionId === undefined) {
    pick.append(new Option('Choose a session…', '', true, true))
  }
  for (const s of sessions) {
    const label = `${s.name} — ${feedWord(s)}`
    pick.append(new Option(label, s.sessionId, false, s.sessionId === sessionId))
  }
  if (sessionId !== undefined && !sessions.some(s => s.sessionId === sessionId)) {
    pick.append(new Option(`${sessionId.slice(0, 8)}… — gone`, sessionId, false, true))
  }
  pick.hidden = sessions.length === 0 && sessionId === undefined

  if (sessionId !== undefined) return
  const list = $<HTMLUListElement>('list')
  list.replaceChildren()
  $('empty').hidden = sessions.length > 0
  for (const s of sessions) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = `?session=${encodeURIComponent(s.sessionId)}`
    a.className = [s.feed, s.feed === 'live' && s.activity === 'busy' ? 'busy' : ''].join(' ')
    const light = el('span', 'light')
    const name = el('span', 'name', s.name)
    const bits = [home(s.cwd)]
    if (s.model) bits.push(shortModel(s.model))
    if (s.running > 0 && s.feed === 'live') bits.push(`${s.running} running`)
    if (s.startedAt) bits.push(`started ${ago(Date.now() - s.startedAt)} ago`)
    const where = el('span', 'where', bits.filter(Boolean).join('   '))
    const gauge = el('span', 'gauge')
    if (s.context !== undefined) {
      const pct = Math.max(0, Math.min(100, Math.round(s.context)))
      gauge.classList.toggle('full', pct >= 85)
      const track = el('span')
      const fill = el('i')
      fill.style.width = `${pct}%`
      track.append(fill)
      gauge.append(el('b', '', `context ${pct}%`), track)
    }
    const state = el('span', 'state', feedWord(s))
    a.append(light, name, gauge, state, where)
    li.append(a)
    list.append(li)
  }
}

$<HTMLSelectElement>('pick').addEventListener('change', e => {
  const id = (e.target as HTMLSelectElement).value
  const next = new URLSearchParams(location.search)
  if (id === '') next.delete('session')
  else next.set('session', id)
  location.search = next.toString()
})

// ---------------------------------------------------------------------------------------------
// The map of one session

let view: View | undefined
const scope = new Scope($('map'))
const art = $('art')
const inkField = InkField.create($<HTMLCanvasElement>('ink'))
const timeline = new Timeline($('timeline'))
/** The diagram is shown where there is no WebGL, or when the ⚙ options ask for it. */
const useDiagram = () => inkField === undefined || pref('view') === 'diagram'

/**
 * A call still running, as far as the picture goes. A background task that never sent word of how it
 * ended (its session was closed under it) stays open in the list, but after six hours it no longer
 * lights its node or line, or keeps the window redrawing.
 */
const isRunning = (e: { status: string; startedAt: number }, now: number) => e.status === 'run' && now - e.startedAt < 6 * 3600_000

// ---------------------------------------------------------------------------------------------
// The ink view: where each activity sits, its mark there, and the ink its calls put down.

/** Where an activity (or Claude, at the centre) sits on the ink, in CSS pixels of the art box. */
function seatAt(id: StationId | 'core', w: number, h: number): { x: number; y: number } {
  const cx = w / 2
  const cy = h * 0.4
  if (id === 'core') return { x: cx, y: cy }
  const r = Math.min(w * 0.3, h * 0.29)
  const shift = pref('layout') === 'you-bottom' ? STATIONS.length / 2 : 0
  const a = ((STATIONS.findIndex(s => s.id === id) + shift) * 2 * Math.PI) / STATIONS.length
  return { x: cx + r * 1.18 * Math.sin(a), y: cy - r * Math.cos(a) }
}

const seatEls = new Map<StationId, { root: HTMLElement; name: HTMLElement; count: HTMLElement }>()
for (const s of STATIONS) {
  const root = el('div', 'seat')
  // The activity as rendered in Blender (art/render.py): the object, and over it its glow, a white
  // mask the page tints with the activity's colour, so skins and the desktop theme still apply.
  const art = el('span', 'art')
  const body = document.createElement('img')
  body.className = 'body'
  body.src = `art/${s.id}.webp`
  body.alt = ''
  body.draggable = false
  const glow = el('span', 'glow')
  glow.style.setProperty('--glow', `url(art/${s.id}-glow.webp)`)
  art.append(body, glow)
  const name = el('b')
  const count = el('i')
  root.append(art, name, count)
  $('seats').append(root)
  seatEls.set(s.id, { root, name, count })
}

function placeSeats() {
  const w = art.clientWidth
  const h = art.clientHeight
  for (const [id, { root }] of seatEls) {
    const p = seatAt(id, w, h)
    root.style.left = `${p.x}px`
    root.style.top = `${p.y}px`
  }
  const c = seatAt('core', w, h)
  inkField?.setRing(Math.min(w * 0.3, h * 0.29))
  $('core').style.left = `${c.x}px`
  $('core').style.top = `${c.y}px`
  inkField?.resize(w, h)
  inkField?.setCentre(c.x / Math.max(1, w), c.y / Math.max(1, h))
}
new ResizeObserver(placeSeats).observe(art)

/** The session the ink was last fed for, the calls it has had ink for, and those that went wrong. */
let inkFor: string | undefined
let inkSeen = new Set<string>()
let inkFaults = new Set<string>()
let inkEnded = new Set<string>()

function feedInk(sessionKey: string, state: Board, now: number) {
  if (inkField === undefined || useDiagram()) return
  const w = Math.max(1, art.clientWidth)
  const h = Math.max(1, art.clientHeight)
  const at = (id: StationId | 'core') => {
    const p = seatAt(id, w, h)
    return { x: p.x / w, y: p.y / h }
  }
  const css = getComputedStyle(document.documentElement)
  const red = css.getPropertyValue('--red').trim() || '#e8654f'
  const bone = css.getPropertyValue('--bone').trim() || '#ebe6dc'
  const ash = css.getPropertyValue('--ash').trim() || '#9ba1ab'
  const first = inkFor !== sessionKey
  if (first) {
    inkFor = sessionKey
    inkSeen = new Set()
    inkFaults = new Set()
    inkEnded = new Set()
  }
  /**
   * The straight line a call travels: from Claude (or the subagent) to the activity, or, for a message
   * coming in, the other way. It stops short of the words at the centre and of the activity's shape.
   */
  const line = (from: StationId | 'core', to: StationId): { a: { x: number; y: number }; b: { x: number; y: number } } => {
    const p = seatAt(from, w, h)
    const q = seatAt(to, w, h)
    const d = Math.hypot(q.x - p.x, q.y - p.y) || 1
    const ux = (q.x - p.x) / d
    const uy = (q.y - p.y) / d
    const start = from === 'core' ? 62 : 40
    return { a: { x: (p.x + ux * start) / w, y: (p.y + uy * start) / h }, b: { x: (q.x - ux * 40) / w, y: (q.y - uy * 40) / h } }
  }
  const ends = (e: Board['entries'][number]) => {
    const { a, b } = line(e.from === 'agents' ? 'agents' : 'core', e.station)
    const place = at(e.station)
    return e.from === 'inbound' ? { out: b, to: a, place } : { out: a, to: b, place }
  }
  for (const e of state.entries.slice(-120)) {
    const bad = e.status === 'err' || e.status === 'block'
    const recent = now - (e.endedAt ?? e.startedAt) < 60_000
    if (bad && !inkFaults.has(e.id)) {
      // A call that went wrong spills red where it happened.
      inkFaults.add(e.id)
      if (!first || recent) inkField.add({ ...at(e.station), colour: red, amount: 0.7, radius: 0.05 })
    }
    if (e.endedAt !== undefined && !inkEnded.has(e.id)) {
      inkEnded.add(e.id)
      // The answer flows back: a fainter signal from the activity to whoever called it. A call that
      // came and went between two looks at the transcript still shows both ways, in order: its answer
      // sets off once the call has landed, as lot-map times each pulse by the call's own clock.
      if (!first && e.from !== 'inbound' && e.mark === undefined) {
        const { out, to } = ends(e)
        const sentNow = !inkSeen.has(e.id)
        inkField.signal(to, out, bad ? red : mix(stationColor(e.station), ash, 0.35), 0.7, 600, undefined, sentNow ? 700 : 0)
      }
    }
    if (inkSeen.has(e.id)) continue
    inkSeen.add(e.id)
    const age = now - e.startedAt
    // Opening a session mid-way: the last minute's calls are laid down as blooms, older ones fainter.
    if (first && age > 60_000) continue
    const strength = first ? 0.55 * Math.max(0.2, 1 - age / 60_000) : 1
    if (e.mark === 'done') {
      inkField.add({ ...at('core'), colour: bone, amount: 0.4 * strength, radius: 0.07 })
      continue
    }
    if (e.mark === 'switch') {
      inkField.add({ ...at('core'), colour: stationColor('model'), amount: 0.35 * strength, radius: 0.06 })
      continue
    }
    const colour = stationColor(e.station)
    const bloom = { ...ends(e).place, colour, amount: (e.station === 'model' ? 0.42 : 0.75) * strength, radius: e.station === 'model' ? 0.06 : 0.055 }
    if (first) inkField.add(bloom)
    else {
      // The call travels: a signal straight from the caller to the activity, blooming where it lands.
      const { out, to } = ends(e)
      inkField.signal(out, to, colour, 1, 650, e.from === 'inbound' ? { ...at('core'), colour, amount: 0.3, radius: 0.05 } : bloom)
    }
  }
  // While a call runs, ink gathers where it runs and a stream goes out to it every second or so.
  const feeds: Feed[] = []
  const fed = new Set<string>()
  for (const e of state.entries) {
    const key = `${e.station}|${e.from}`
    if (e.status !== 'run' || e.from === 'inbound' || fed.has(key) || now - e.startedAt > 6 * 3600_000) continue
    fed.add(key)
    const { out, to } = ends(e)
    feeds.push({ key, from: out, to, colour: stationColor(e.station), amount: e.station === 'model' ? 0.009 : 0.016 })
  }
  inkField.setFeeds(feeds)

  // The lines: Claude to every activity, and a subagent to what it is using while that lasts.
  const restLine = css.getPropertyValue('--line').trim() || '#272c36'
  const links: Link[] = []
  const lastOf = (station: StationId, agents: boolean) => {
    const own = state.entries.filter(e => e.station === station && (e.from === 'agents') === agents)
    const last = own[own.length - 1]
    return { running: own.some(e => isRunning(e, now)), lastAt: last === undefined ? 0 : (last.endedAt ?? last.startedAt) }
  }
  for (const s of STATIONS) {
    const { a, b } = line('core', s.id)
    // Worn in with use, as lot-map's spokes: log-scaled, so the first calls show and a busy line does not swamp the rest.
    const worn = Math.min(1, Math.log2(1 + (state.counts[s.id] ?? 0)) / 7)
    links.push({ from: a, to: b, colour: stationColor(s.id), rest: restLine, worn, ...lastOf(s.id, false) })
  }
  for (const s of STATIONS) {
    if (s.id === 'agents') continue
    const use = lastOf(s.id, true)
    if (!use.running && now - use.lastAt > 6000) continue
    const { a, b } = line('agents', s.id)
    links.push({ from: a, to: b, colour: stationColor(s.id), rest: restLine, ...use })
  }
  inkField.setLinks(links)
}

/** Two colours mixed, t of the way from a to b. */
function mix(a: string, b: string, t: number): string {
  const c = (hex: string) => {
    let h = hex.replace('#', '')
    if (h.length === 3) h = h.split('').map(x => x + x).join('')
    const n = Number.parseInt(h.slice(0, 6), 16)
    return Number.isNaN(n) ? [128, 128, 128] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const x = c(a)
  const y = c(b)
  return `#${x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

function drawSeats(state: Board, t: Setup['t'], now: number) {
  for (const s of STATIONS) {
    const seat = seatEls.get(s.id)
    if (seat === undefined) continue
    const own = state.entries.filter(e => e.station === s.id)
    const last = own[own.length - 1]
    const running = own.some(e => isRunning(e, now))
    const fault = own.filter(e => e.status === 'err' || e.status === 'block').pop()
    const count = state.counts[s.id] ?? 0
    seat.root.style.setProperty('--h', stationColor(s.id))
    seat.root.classList.toggle('used', count > 0)
    seat.root.classList.toggle('run', running)
    seat.root.classList.toggle('live', running || (last !== undefined && now - (last.endedAt ?? last.startedAt) < 6000))
    seat.root.classList.toggle('alarm', fault !== undefined && now - (fault.endedAt ?? fault.startedAt) < 8000)
    seat.name.textContent = t.stations[s.id]
    seat.count.textContent = count > 0 ? String(count) : ''
  }
}

/** The caption, kept so the time in it can move on between updates. */
let captionFor: { state: Board; t: Setup['t']; feed: Summary['feed'] } | undefined
function drawCaption() {
  if (captionFor === undefined) return
  const c = caption({ board: captionFor.state, t: captionFor.t, now: Date.now(), feed: captionFor.feed })
  const box = $('caption')
  const title = $('capTitle')
  if (title.textContent !== c.title) {
    title.textContent = c.title
    // The new caption settles in; the class is taken off and put back to play that once.
    box.classList.remove('changed')
    void box.offsetWidth
    box.classList.add('changed')
  }
  $('capDetail').textContent = c.detail
  if (c.station === undefined) box.style.removeProperty('--h')
  else box.style.setProperty('--h', stationColor(c.station))
}
setInterval(() => {
  if (captionFor !== undefined && isVisible() && captionFor.state.entries.some(e => isRunning(e, Date.now()))) drawCaption()
}, 1000)

function drawView() {
  if (view === undefined) return
  const banner = $('banner')
  document.body.classList.toggle('diagram', useDiagram())
  if ('missing' in view) {
    banner.hidden = false
    banner.textContent = 'This session is not known to the hub. It may have ended long ago; pick another one above.'
    scope.set({ board: { entries: [], counts: {} }, setup: setupFor(), busy: false })
    captionFor = undefined
    $('capTitle').textContent = ''
    $('capDetail').textContent = ''
    document.body.classList.remove('busy')
    $('feed').replaceChildren()
    return
  }
  const { session } = view
  const setup = view.adapter.setupUsed
  const board = view.adapter.board
  const { t } = setup
  applyTheme(setup)
  refreshColors()
  document.title = `SessionBrain — ${session.name}`
  debug(`drawn ${session.name} entries=${board.entries.length} hidden=${document.hidden}`)
  $('meta').textContent = [home(session.cwd), session.model ? shortModel(session.model) : '', feedWord(session)].filter(Boolean).join(' · ')

  const notes: Record<Summary['feed'], string> = {
    live: '',
    nofeed: 'Waiting for this session to start writing its transcript. The view comes alive with its first message.',
    ended: 'This session has ended. The view shows where it finished.',
  }
  banner.textContent = notes[session.feed]
  banner.hidden = notes[session.feed] === ''

  const now = Date.now()
  let state: Board = board
  const at = session.lastSeen ?? now
  if (session.feed !== 'live') {
    // Nothing more will happen: what was running is drawn as stopped where the session left it.
    state = { ...state, agents: [], entries: state.entries.map(e => (e.status === 'run' ? { ...e, status: 'ok' as const, endedAt: at } : e)) }
  } else if (session.activity === 'idle' && now - at > 5000) {
    // Claude says the session is idle: a turn whose end was not written is over all the same
    // (background tasks it started go on).
    state = { ...state, entries: state.entries.map(e => (e.status === 'run' && e.task === undefined && e.from === 'core' ? { ...e, status: 'ok' as const, endedAt: at } : e)) }
  }
  const busy = session.feed === 'live' && session.activity === 'busy'
  document.body.classList.toggle('busy', busy)
  $('art').setAttribute('aria-label', `${t.title}. ${describeNow(state, t)}`)

  if (useDiagram()) {
    scope.setVisible(isVisible())
    scope.set({ board: state, setup, busy })
  } else {
    scope.setVisible(false)
    const css = getComputedStyle(document.documentElement)
    const ground = css.getPropertyValue('--ground').trim() || '#0a0c11'
    inkField?.setGround(ground, document.documentElement.getAttribute('data-theme') === 'dark' || (document.documentElement.getAttribute('data-theme') !== 'light' && luminance(ground) < 0.5))
    feedInk(session.sessionId, state, now)
    drawSeats(state, t, now)
    $('coreName').textContent = setup.core
    $('coreModel').textContent = state.model === undefined ? '' : shortModel(state.model)
    const context = $('coreContext')
    const full = state.context === undefined ? undefined : Math.round(state.context)
    context.textContent = full === undefined ? '' : `${full}% ${t.context}`
    context.classList.toggle('high', full !== undefined && full >= 70 && full < 90)
    context.classList.toggle('full', full !== undefined && full >= 90)
  }

  captionFor = { state, t, feed: session.feed }
  drawCaption()
  timeline.set(state, t.stations)
  // The tape. Calls that were not there at the last draw come in with a flash.
  const rows = foldRows(state.entries)
  const feed = $('feed')
  const seenBefore = drawnFor === session.sessionId ? seenRows : undefined
  seenRows = new Set(rows.map(r => r.entry.id))
  drawnFor = session.sessionId
  feed.replaceChildren()
  if (rows.length === 0) feed.append(el('li', 'ok', t.nothingYet))
  for (const { entry, times, tookMs } of rows) {
    const isSwitch = entry.mark === 'switch'
    const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
    const took = entry.endedAt === undefined ? t.running : tookMs > 0 ? formatMs(tookMs, t) : ''
    const li = el('li', isSwitch ? 'switch' : entry.status === 'run' ? 'run' : entry.status === 'ok' ? 'ok' : 'fault')
    if (seenBefore !== undefined && !seenBefore.has(entry.id)) li.classList.add('fresh')
    const label = `${entry.label}${times > 1 ? `  +${times - 1}` : ''}`
    li.style.setProperty('--h', stationColor(entry.station))
    li.append(el('span', 'mk', mark), el('span', 'st', t.stations[entry.station]), el('span', 'lb', label), el('span', 'tk', took))
    li.title = `${t.stations[entry.station]}: ${label}${took === '' ? '' : `, ${took}`}`
    feed.append(li)
  }
}
/** The session the tape was last drawn for, and the calls it showed then. */
let drawnFor: string | undefined
let seenRows = new Set<string>()

// ---------------------------------------------------------------------------------------------
// When to draw. Updates that arrive together are drawn once, a frame's time later. Out of sight the
// map stops: no redraws, and its animation is paused (WebKit would otherwise keep animating a
// window on another workspace). The SessionBrain app says when its window is out of sight; in any
// other browser the page's own visibility says it.

let shownByHost = true
let queued = false
type Host = { __sessionbrainHost?: boolean; __sessionbrainDebug?: boolean; ipc?: { postMessage: (m: string) => void } }
const host = window as unknown as Host
// Inside the SessionBrain app the window says when it is in sight; WebKitGTK's own page visibility is not to be trusted there.
const isVisible = () => shownByHost && (host.__sessionbrainHost === true || !document.hidden)
const debug = (m: string) => {
  if (host.__sessionbrainDebug) host.ipc?.postMessage(m)
}

function scheduleDraw() {
  if (queued || !isVisible()) return
  queued = true
  // A timer, not requestAnimationFrame: WebKitGTK may never run frame callbacks for this window.
  setTimeout(() => {
    queued = false
    if (isVisible()) drawView()
  }, 16)
}

function applyVisibility() {
  const visible = isVisible()
  debug(`visible ${visible} (host ${shownByHost}, document.hidden ${document.hidden})`)
  document.body.classList.toggle('paused', !visible)
  scope.setVisible(visible && useDiagram())
  inkField?.setVisible(visible && !useDiagram())
  timeline.setVisible(visible)
  if (visible) scheduleDraw()
}
document.addEventListener('visibilitychange', applyVisibility)
;(window as unknown as { __sessionbrainVisible: (v: boolean) => void }).__sessionbrainVisible = (v: boolean) => {
  shownByHost = v
  applyVisibility()
}

/** Whether a redraw now would change anything: a call is running, or something recent is still fading. */
function isAlive(): boolean {
  if (view === undefined || 'missing' in view) return false
  const now = Date.now()
  return view.adapter.board.entries.some(e => isRunning(e, now) || now - (e.endedAt ?? e.startedAt) < 70_000)
}

// The drawing carries its own animation; a redraw now and then lets long-finished marks go.
setInterval(() => {
  if (isAlive()) scheduleDraw()
}, 10_000)

// ---------------------------------------------------------------------------------------------
// Display options dialog

const dialog = $<HTMLDialogElement>('prefs')
$('prefsButton').addEventListener('click', () => {
  const form = dialog.querySelector('form')!
  renderSkins()
  for (const key of PREF_KEYS) (form.elements.namedItem(key) as HTMLInputElement).value = prefs[key] ?? ''
  dialog.showModal()
})
dialog.addEventListener('close', () => {
  const form = dialog.querySelector('form')!
  if (dialog.returnValue === 'reset') prefs = {}
  else {
    prefs = {}
    for (const key of PREF_KEYS) {
      const value = (form.elements.namedItem(key) as HTMLInputElement).value.trim()
      if (value !== '') prefs[key] = value
    }
  }
  savePrefs(prefs)
  // The labels depend on the language and the colours on the skin: the map is built again from the records.
  applySkinChange()
  // The view may have changed between ink and diagram.
  placeSeats()
  applyVisibility()
})

// The skins as swatches, each in its own colours; picking one tries it on at once.
const CLASSIC = { ground: '#0a0c11', line: '#272c36', bone: '#ebe6dc', accent: '#e1ac6e', hot: '#f0c595', mem: '#62c7ba', red: '#e8654f' }
function renderSkins() {
  const box = $('skins')
  box.querySelector('.grid')?.remove()
  const grid = el('div', 'grid')
  const chosen = prefs.skin ?? ''
  for (const [name, label] of Object.entries(SKIN_LABELS) as [SkinName, string][]) {
    const skin = name === 'classic' ? undefined : name === 'omarchy' ? (desktopColors && omarchySkin(desktopColors)) : SKINS[name]
    const c = skin?.palette ?? CLASSIC
    const value = name === 'classic' ? '' : name
    const option = el('label', 'swatch')
    const input = el('input')
    input.type = 'radio'
    input.name = 'skin'
    input.value = value
    input.checked = value === chosen
    input.addEventListener('change', () => {
      prefs = { ...prefs, skin: value === '' ? undefined : value }
      applySkinChange()
    })
    const face = el('span', `face${skin !== undefined && skin.glow > 0 ? ' glows' : ''}`)
    face.style.setProperty('--g', c.ground)
    face.style.setProperty('--l', c.line)
    face.style.setProperty('--t', c.bone)
    face.style.setProperty('--a', c.accent)
    const dots = el('span', 'dots')
    for (const colour of [c.accent, c.hot, c.mem, c.red]) {
      const dot = el('i')
      dot.style.background = colour
      dot.style.color = colour
      dots.append(dot)
    }
    face.append(dots, el('b', '', label.replace(/ \(.*\)$/, '')))
    option.title = label
    option.append(input, face)
    grid.append(option)
  }
  box.append(grid)
}
void loadDesktopColors()
setInterval(() => {
  if (pref('skin') === 'omarchy' && !document.hidden) void loadDesktopColors()
}, 5000)

// ---------------------------------------------------------------------------------------------
// The live stream from the hub

$('picker').hidden = sessionId !== undefined
$('viewer').hidden = sessionId === undefined
applyTheme(setupFor())

function connect() {
  const source = new EventSource(sessionId === undefined ? '/stream' : `/stream?session=${encodeURIComponent(sessionId)}`)
  const link = $('link')
  source.addEventListener('open', () => {
    link.className = 'link on'
    link.title = 'Connected to the SessionBrain hub'
    $('linkWord').textContent = 'Live'
  })
  source.addEventListener('error', () => {
    link.className = 'link off'
    link.title = 'The SessionBrain hub is not answering; retrying'
    $('linkWord').textContent = 'Reconnecting'
  })
  source.addEventListener('sessions', e => {
    sessions = JSON.parse((e as MessageEvent).data) as Summary[]
    renderSessions()
    // The followed session's state (open, idle, ended) comes with the list.
    const mine = sessions.find(s => s.sessionId === sessionId)
    if (mine !== undefined && view !== undefined && !('missing' in view)) {
      view = { ...view, session: mine }
      scheduleDraw()
    }
  })
  source.addEventListener('show', e => {
    // Super+Shift+W asks the SessionBrain window (not an Orca tab) to switch to the session in sight.
    const id = (e as MessageEvent).data as string
    if (host.__sessionbrainHost === true && id !== sessionId) location.search = `?session=${encodeURIComponent(id)}`
  })
  source.addEventListener('view', e => {
    // Everything about the session: on connecting, and when its transcript started over.
    const data = JSON.parse((e as MessageEvent).data) as { session: Summary; records: Rec[] } | { missing: string }
    if ('missing' in data) view = data
    else {
      const adapter = new Adapter(setupFor())
      adapter.add(data.records)
      view = { session: data.session, adapter }
    }
    scheduleDraw()
  })
  source.addEventListener('records', e => {
    if (view === undefined || 'missing' in view) return
    view.adapter.add((JSON.parse((e as MessageEvent).data) as { records: Rec[] }).records)
    scheduleDraw()
  })
}
connect()

/** How light a colour is, 0 to 1. */
function luminance(hex: string): number {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = Number.parseInt(h.slice(0, 6), 16)
  if (Number.isNaN(n)) return 0
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

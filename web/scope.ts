// The map, drawn by SessionBrain on a canvas.
//
// A flat, precise diagram: the session at the centre, the ten kinds of activity around it, each with
// its own colour. Lines are hairlines; a line takes its activity's colour only while that activity
// is live, and a single dot travels along it while a call runs. Words sit outside the nodes, facing
// away from the centre, so no line crosses them. Motion is kept to what tells you something: a
// spinner and a quiet pulse on what is running, a dot for each call.
//
// lot-map still reads the transcript into a Board (adapter.ts); this only draws that Board.

import type { Board, Entry, StationId } from './lot-map/types'
import { STATIONS, shortModel } from './lot-map/map'
import type { Setup } from './lot-map/map'
import { ICONS } from './icons'

export const W = 1000
export const H = 780
const CX = 500
const CY = 390
const R = 292
const NODE = 27
const CORE = 60

type P = { x: number; y: number }

// ---------------------------------------------------------------------------------------------
// Colour. The skin gives the ground and the words (CSS variables); the activities have their own
// colours, one set for dark grounds and one for light.

const HUES_DARK: Record<StationId, string> = {
  you: '#94a3b8', model: '#a78bfa', memory: '#2dd4bf', files: '#fbbf24', shell: '#a3e635',
  web: '#38bdf8', browser: '#818cf8', agents: '#f472b6', skills: '#fb923c', hooks: '#e879f9',
}
const HUES_LIGHT: Record<StationId, string> = {
  you: '#475569', model: '#7c3aed', memory: '#0d9488', files: '#d97706', shell: '#65a30d',
  web: '#0284c7', browser: '#4f46e5', agents: '#db2777', skills: '#ea580c', hooks: '#c026d3',
}

type Ink = { ground: string; raised: string; line: string; bone: string; ash: string; dim: string; red: string; amber: string; dark: boolean }

function rgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = Number.parseInt(h.slice(0, 6), 16)
  return Number.isNaN(n) ? [128, 128, 128] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const toHex = (c: [number, number, number]) => `#${c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a)
  const y = rgb(b)
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}
const alpha = (c: string, a: number) => {
  const [r, g, b] = rgb(c)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`
}

function readInk(): Ink {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const ground = v('--ground', '#0a0c11')
  const [r, g, b] = rgb(ground)
  const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
  return {
    ground, raised: v('--raised', '#12151c'), line: v('--line', '#272c36'), bone: v('--bone', '#ebe6dc'), ash: v('--ash', '#9ba1ab'),
    dim: v('--dim', '#6b7280'), red: v('--red', '#e8654f'), amber: dark ? '#fbbf24' : '#d97706', dark,
  }
}

let ink: Ink = { ground: '#0a0c11', raised: '#12151c', line: '#272c36', bone: '#ebe6dc', ash: '#9ba1ab', dim: '#6b7280', red: '#e8654f', amber: '#fbbf24', dark: true }

/** An activity's colour on the current ground; the ink, the tape and the timeline use it too. */
export function stationColor(id: StationId): string {
  return (ink.dark ? HUES_DARK : HUES_LIGHT)[id]
}

/** Reads the skin's colours from the page, so stationColor() matches the current ground. */
export function refreshColors() {
  ink = readInk()
}


// ---------------------------------------------------------------------------------------------

const FLIGHT_MS = 700
const STREAM_MS = 1400
const LIT_MS = 6000
const ALARM_MS = 8000
const PULSE_MS = 2200
const DONE_MS = 1800
const SWITCH_MS = 4000

const FONT = '"Geist", "Inter", system-ui, sans-serif'
const MONO = '"Geist Mono", ui-monospace, monospace'

export type Scene = { board: Board; setup: Setup; busy: boolean }

export class Scope {
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  /** The canvas holds the still map and is drawn again only when it changes; what moves is a small SVG layer over it, redrawn fifteen times a second while anything moves. */
  private overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  private stillKey = ''
  private lastFrame = ''
  private g: CanvasRenderingContext2D
  private scale = 1
  private scene: Scene | undefined
  private visible = true
  private timer: ReturnType<typeof setTimeout> | undefined
  private shift = 0
  private motion = !matchMedia('(prefers-reduced-motion: reduce)').matches
  private icons = new Map<StationId, Path2D>()

  constructor(private host: HTMLElement) {
    this.canvas.setAttribute('aria-hidden', 'true')
    host.append(this.canvas)
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D
    this.g = this.ctx
    this.overlay.setAttribute('viewBox', `0 0 ${W} ${H}`)
    this.overlay.setAttribute('aria-hidden', 'true')
    this.overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'
    host.append(this.overlay)
    for (const s of STATIONS) this.icons.set(s.id, new Path2D(ICONS[s.id]))
    new ResizeObserver(() => this.resize()).observe(host)
    this.resize()
    void Promise.all([document.fonts.load(`500 13px ${FONT}`), document.fonts.load(`400 12px ${MONO}`)]).then(() => this.kick())
  }

  set(scene: Scene) {
    this.scene = scene
    this.shift = scene.setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0
    ink = readInk()
    this.stillKey = ''
    this.kick()
  }

  setVisible(v: boolean) {
    this.visible = v
    if (v) this.kick()
    else if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Draw the still map if it changed, and look again soon while lines and nodes are fading. A timer, since WebKitGTK may never run frame callbacks for this window. */
  private kick() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.visible || this.host.clientWidth === 0) return
    const now = Date.now()
    const fading = this.draw(now)
    const { svg, moving } = this.motion ? this.frame(now) : { svg: '', moving: false }
    if (svg !== this.lastFrame) {
      this.overlay.innerHTML = svg
      this.lastFrame = svg
    }
    // Fifteen frames a second while something moves: smooth enough for a dot, and each frame costs the
    // window a repaint. Otherwise only as often as a fade needs.
    this.timer = setTimeout(() => this.kick(), moving ? 66 : fading ? 250 : 2000)
  }

  private resize() {
    const cssW = Math.max(1, this.host.clientWidth)
    const cssH = (cssW * H) / W
    // Sharp on any screen, but no more pixels than a crisp line needs.
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.scale = (cssW * dpr) / W
    this.stillKey = ''
    this.kick()
  }

  private seat(id: StationId): P {
    const i = STATIONS.findIndex(s => s.id === id)
    const a = ((i + this.shift) * 2 * Math.PI) / STATIONS.length
    return { x: CX + R * Math.sin(a), y: CY - R * Math.cos(a) }
  }

  /** The two ends of the line a call travels: from the core (or the agents node) to its station. */
  private ends(e: Pick<Entry, 'station' | 'from'>): [P, P] {
    const to = this.seat(e.station)
    const from = e.from === 'agents' ? this.seat('agents') : { x: CX, y: CY }
    const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
    const ux = (to.x - from.x) / d
    const uy = (to.y - from.y) / d
    const start = e.from === 'agents' ? NODE + 4 : CORE + 8
    return [
      { x: from.x + ux * start, y: from.y + uy * start },
      { x: to.x - ux * (NODE + 4), y: to.y - uy * (NODE + 4) },
    ]
  }

  /** Draws the still map when anything in it has changed. Returns whether something is still fading. */
  private draw(now: number): boolean {
    const scene = this.scene
    if (scene === undefined) return false
    const { board, setup, busy } = scene
    const recent = board.entries.slice(-60)
    const own = new Map<StationId, Entry[]>()
    for (const e of recent) own.set(e.station, [...(own.get(e.station) ?? []), e])
    // Fades move in small steps, so the map is drawn again only a few times while they last.
    const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
    const key = [
      this.canvas.width, ink.ground, ink.raised, ink.line, ink.bone, setup.layout, setup.core, setup.t.stations.you, board.model, board.context === undefined ? '' : Math.round(board.context),
      switchAge < SWITCH_MS, busy, board.pushed,
      ...STATIONS.map(s => {
        const list = own.get(s.id) ?? []
        return [board.counts[s.id] ?? 0, Math.round(this.litness(list, now) * 12), this.alarmed(list, now), list.filter(e => e.status === 'run').length, board.faults?.[s.id] ?? 0].join(',')
      }),
    ].join('|')
    if (key !== this.stillKey) {
      this.stillKey = key
      const g = this.ctx
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, this.canvas.width, this.canvas.height)
      g.setTransform(this.scale, 0, 0, this.scale, 0, 0)
      this.g = g
      this.drawStill(board, setup, own, now)
    }
    return recent.some(e => e.status !== 'run' && now - (e.endedAt ?? e.startedAt) < Math.max(LIT_MS, ALARM_MS))
  }

  private alarmed(list: readonly Entry[], now: number): boolean {
    const alarm = list.filter(e => e.status === 'block' || e.status === 'err').pop()
    return alarm !== undefined && now - (alarm.endedAt ?? alarm.startedAt) < ALARM_MS
  }

  private drawStill(board: Board, setup: Setup, own: Map<StationId, Entry[]>, now: number) {
    const g = this.g
    // The orbit: one quiet ring through the stations.
    g.strokeStyle = alpha(ink.line, 0.55)
    g.lineWidth = 1
    g.beginPath()
    g.arc(CX, CY, R, 0, Math.PI * 2)
    g.stroke()

    // Spokes: hairlines, in their activity's colour while it is live.
    for (const s of STATIONS) {
      const lit = this.litness(own.get(s.id) ?? [], now)
      const [a, b] = this.ends({ station: s.id, from: 'core' })
      g.lineWidth = lit > 0 ? 1.5 : 1
      g.strokeStyle = lit > 0 ? alpha(stationColor(s.id), 0.35 + 0.6 * lit) : ink.line
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
      g.stroke()
    }
    for (const s of STATIONS) this.drawStation(s.id, own.get(s.id) ?? [], board, setup, now)
    this.drawCore(board, setup, now)
  }

  /** Everything that moves, at one moment, as plain SVG over the still map. Returns the SVG and whether anything moves. */
  private frame(now: number): { svg: string; moving: boolean } {
    const scene = this.scene
    if (scene === undefined) return { svg: '', moving: false }
    const { board, busy } = scene
    const recent = board.entries.slice(-60)
    const n = (v: number) => (Math.round(v * 10) / 10).toString()
    const circle = (x: number, y: number, r: number, color: string, opacity = 1) =>
      opacity <= 0.01 ? '' : `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${color}"${opacity < 1 ? ` opacity="${opacity.toFixed(2)}"` : ''}/>`
    const ring = (x: number, y: number, r: number, color: string, opacity: number, width = 1) =>
      opacity <= 0.01 ? '' : `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity.toFixed(2)}"/>`
    const along = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * ease(t), y: a.y + (b.y - a.y) * ease(t) })
    let out = ''
    let moving = false

    // Calls in flight: one dot each, out along the line while the call runs; a fainter one back when it ends.
    let shown = 0
    for (let k = recent.length - 1; k >= 0 && shown < 24; k--) {
      const e = recent[k]
      if (e === undefined) continue
      const [a, b] = this.ends(e)
      const inward = e.from === 'inbound'
      const [p, q] = inward ? [b, a] : [a, b]
      const bad = e.status === 'err' || e.status === 'block'
      const color = bad ? ink.red : stationColor(e.station)
      const age = now - e.startedAt
      let t: number | undefined
      if (e.status === 'run') t = (age % STREAM_MS) / STREAM_MS
      else if (age >= 0 && age < FLIGHT_MS) t = age / FLIGHT_MS
      if (t !== undefined) {
        const at = along(p, q, t)
        out += circle(at.x, at.y, 3, color, t > 0.85 ? (1 - t) / 0.15 : 1)
        shown++
        moving = true
      }
      if (e.endedAt !== undefined && !inward) {
        const back = now - e.endedAt
        if (back >= 0 && back < FLIGHT_MS) {
          const u = back / FLIGHT_MS
          const at = along(b, a, u)
          out += circle(at.x, at.y, 2.2, bad ? ink.red : ink.ash, u > 0.85 ? (1 - u) / 0.15 : 1)
          shown++
          moving = true
        }
      }
    }

    // What runs at a station: a quiet pulse spreading from the node, and a spinner on its rim.
    for (const s of STATIONS) {
      const list = recent.filter(e => e.station === s.id)
      const running = list.filter(e => e.status === 'run')
      if (running.length === 0) continue
      const p = this.seat(s.id)
      const tone = this.alarmed(list, now) ? ink.red : stationColor(s.id)
      const elapsed = now - Math.min(...running.map(e => e.startedAt))
      const phase = (elapsed % PULSE_MS) / PULSE_MS
      out += ring(p.x, p.y, NODE + 4 + phase * 22, tone, 0.4 * (1 - phase))
      const r = NODE + 4.5
      const turn = ((now % 1100) / 1100) * 360
      out += `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r)}" fill="none" stroke="${tone}" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="${n(2 * Math.PI * r * 0.3)} ${n(2 * Math.PI * r)}" transform="rotate(${turn.toFixed(1)} ${n(p.x)} ${n(p.y)})"/>`
      moving = true
    }

    // Subagents at work: small dots going round the agents node.
    const crew = (board.agents ?? []).slice(0, 6)
    if (crew.length > 0) {
      const p = this.seat('agents')
      crew.forEach((_, k) => {
        const a = (now / 6000) * 2 * Math.PI + (k * 2 * Math.PI) / crew.length
        out += circle(p.x + Math.cos(a) * (NODE + 9), p.y + Math.sin(a) * (NODE + 9), 2.4, stationColor('agents'))
      })
      moving = true
    }

    // The core: a quiet pulse while the session works; one ring for a changed model, one for a finished answer.
    if (busy) {
      const phase = (now % 2600) / 2600
      out += ring(CX, CY, CORE + 8 + phase * 30, ink.bone, 0.18 * (1 - phase))
      moving = true
    }
    const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
    if (switchAge >= 0 && switchAge < SWITCH_MS) {
      const phase = (switchAge % 1600) / 1600
      out += ring(CX, CY, CORE + 6 + phase * 26, stationColor('model'), 0.5 * (1 - phase))
      moving = true
    }
    const done = recent.filter(e => e.mark === 'done').pop()
    if (done !== undefined && now >= done.startedAt && now - done.startedAt < DONE_MS) {
      const phase = (now - done.startedAt) / DONE_MS
      out += ring(CX, CY, CORE + 6 + phase * 60, ink.bone, 0.4 * (1 - phase))
      moving = true
    }
    let defs = ''
    for (const s of STATIONS) {
      if (!out.includes(`wl-heat-${s.id}`)) continue
      defs += `<radialGradient id="wl-heat-${s.id}"><stop offset="0" stop-color="${stationColor(s.id)}" stop-opacity=".32"/><stop offset="1" stop-color="${stationColor(s.id)}" stop-opacity="0"/></radialGradient>`
    }
    return { svg: defs === '' ? out : `<defs>${defs}</defs>${out}`, moving }
  }

  /** 1 while something runs at a station, fading to 0 over a few seconds after its last call. */
  private litness(list: readonly Entry[], now: number): number {
    if (list.some(e => e.status === 'run' && e.from !== 'agents')) return 1
    const last = list[list.length - 1]
    if (last === undefined) return 0
    const since = now - (last.endedAt ?? last.startedAt)
    return since < LIT_MS ? 1 - since / LIT_MS : 0
  }

  private drawStation(id: StationId, list: Entry[], board: Board, setup: Setup, now: number) {
    const g = this.g
    const p = this.seat(id)
    const color = stationColor(id)
    const count = board.counts[id] ?? 0
    const running = list.filter(e => e.status === 'run')
    const lit = this.litness(list, now)
    const alarm = list.filter(e => e.status === 'block' || e.status === 'err').pop()
    const isAlarm = alarm !== undefined && now - (alarm.endedAt ?? alarm.startedAt) < ALARM_MS
    const tone = isAlarm ? ink.red : color

    // The node: flat, tinted with its colour while live.
    g.fillStyle = lit > 0 || isAlarm ? mix(ink.raised, tone, 0.14 * Math.max(lit, isAlarm ? 1 : 0)) : ink.raised
    g.beginPath()
    g.arc(p.x, p.y, NODE, 0, Math.PI * 2)
    g.fill()
    g.lineWidth = lit > 0 || isAlarm ? 1.5 : 1
    g.strokeStyle = lit > 0 || isAlarm ? alpha(tone, 0.45 + 0.55 * Math.max(lit, isAlarm ? 1 : 0)) : ink.line
    g.stroke()

    // The icon: in its colour once the activity has been used, grey until then.
    g.save()
    g.translate(p.x, p.y)
    g.scale(1.45, 1.45)
    g.lineWidth = 1.5 / 1.45
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.strokeStyle = isAlarm ? ink.red : count > 0 || lit > 0 ? tone : ink.dim
    g.stroke(this.icons.get(id) as Path2D)
    g.restore()

    // A badge for errors since your last message.
    const corner = NODE * 0.72
    const faults = board.faults?.[id] ?? 0
    if (faults > 0) {
      const text = faults > 99 ? '99+' : String(faults)
      g.font = `600 10px ${FONT}`
      const w = Math.max(16, g.measureText(text).width + 8)
      g.fillStyle = ink.red
      g.beginPath()
      g.roundRect(p.x - corner - w / 2, p.y - corner - 8, w, 16, 8)
      g.fill()
      g.fillStyle = '#ffffff'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(text, p.x - corner, p.y - corner + 0.5)
    }
    // The words, outside the node and away from the centre.
    const dx = p.x - CX
    const dy = p.y - CY
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const ax = p.x + ux * (NODE + 12)
    const ay = p.y + uy * (NODE + 10)
    const align: CanvasTextAlign = Math.abs(ux) < 0.35 ? 'center' : ux > 0 ? 'left' : 'right'
    const top = ay - 15 + uy * 15
    const room = align === 'center' ? 200 : align === 'left' ? W - ax - 4 : ax - 4
    g.textAlign = align
    g.textBaseline = 'alphabetic'
    g.font = `500 13px ${FONT}`
    g.fillStyle = lit > 0 || isAlarm ? ink.bone : ink.ash
    g.fillText(setup.t.stations[id], ax, top + 11, room)
    if (count > 0 || running.length > 1) {
      const pushed = id === 'memory' ? Math.min(count, board.pushed ?? 0) : 0
      const asked = count - pushed
      const figures = pushed === 0 ? String(count) : `${asked > 0 ? `${asked} ` : ''}↓${pushed}`
      // Several calls at once say so beside the count, in the activity's colour.
      const together = running.length > 1 ? `${running.length} running` : ''
      g.font = `400 11.5px ${MONO}`
      const gap = together === '' ? 0 : 8
      const wFig = g.measureText(figures).width
      const wTog = together === '' ? 0 : g.measureText(together).width
      const total = wFig + gap + wTog
      const start = align === 'left' ? ax : align === 'right' ? ax - total : ax - total / 2
      g.textAlign = 'left'
      g.fillStyle = ink.dim
      g.fillText(figures, start, top + 27, room)
      if (together !== '') {
        g.fillStyle = tone
        g.fillText(together, start + wFig + gap, top + 27)
      }
    }
  }

  private drawCore(board: Board, setup: Setup, now: number) {
    const g = this.g
    const full = board.context === undefined ? undefined : Math.max(0, Math.min(100, Math.round(board.context)))
    const ringColor = full === undefined ? ink.line : full >= 90 ? ink.red : full >= 70 ? ink.amber : ink.bone

    g.fillStyle = ink.raised
    g.beginPath()
    g.arc(CX, CY, CORE, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = ink.line
    g.lineWidth = 1
    g.stroke()

    // The context window: a thin ring that fills clockwise from the top.
    g.lineCap = 'round'
    g.strokeStyle = alpha(ink.line, 0.9)
    g.lineWidth = 2
    g.beginPath()
    g.arc(CX, CY, CORE + 6, 0, Math.PI * 2)
    g.stroke()
    if (full !== undefined && full > 0) {
      g.strokeStyle = ringColor
      g.beginPath()
      g.arc(CX, CY, CORE + 6, -Math.PI / 2, -Math.PI / 2 + (full / 100) * Math.PI * 2)
      g.stroke()
    }

    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const name = setup.core
    const size = Math.min(19, 92 / Math.max(1, 0.62 * name.length))
    g.font = `600 ${size.toFixed(1)}px ${FONT}`
    g.fillStyle = ink.bone
    g.fillText(name, CX, CY + (board.model === undefined ? 0 : -3))
    const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
    const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS
    if (board.model !== undefined) {
      g.font = `400 11px ${MONO}`
      g.fillStyle = isSwitching ? stationColor('model') : ink.ash
      g.fillText(shortModel(board.model), CX, CY + 16)
    }
    if (full !== undefined) {
      g.font = `400 10.5px ${MONO}`
      g.fillStyle = full >= 70 ? ringColor : ink.dim
      g.fillText(`${full}%`, CX, CY - 24)
    }
  }
}


/** Gentle start and finish, so a dot glides rather than slides. */
const ease = (t: number) => t * t * (3 - 2 * t)


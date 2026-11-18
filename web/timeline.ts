// The timeline under the ink: one lane per activity, the last few minutes running left to right up to
// now at the right edge. Each call is a bar as long as it took, in its activity's colour; a call still
// running reaches the right edge; errors are red. It is redrawn once a second, which is all it needs.

import type { Board, StationId } from './lot-map/types'
import { STATIONS } from './lot-map/map'
import { stationColor } from './scope'

const SPAN_MS = 5 * 60_000
const LANE = 14
const TOP = 6
const AXIS = 18
const LABELS = 72

export class Timeline {
  private canvas = document.createElement('canvas')
  private g: CanvasRenderingContext2D
  private board: Board | undefined
  private names: Record<StationId, string> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private visible = true

  constructor(private host: HTMLElement) {
    this.canvas.setAttribute('aria-hidden', 'true')
    host.append(this.canvas)
    this.g = this.canvas.getContext('2d') as CanvasRenderingContext2D
    new ResizeObserver(() => this.draw()).observe(host)
  }

  static height(): number {
    return TOP + STATIONS.length * LANE + AXIS
  }

  set(board: Board, names: Record<StationId, string>) {
    this.board = board
    this.names = names
    this.draw()
  }

  setVisible(v: boolean) {
    this.visible = v
    if (v) this.draw()
    else if (this.timer !== undefined) clearTimeout(this.timer)
  }

  private draw() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.visible) return
    const width = this.host.clientWidth
    const height = Timeline.height()
    if (width === 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr)
      this.canvas.height = Math.round(height * dpr)
      this.canvas.style.width = `${width}px`
      this.canvas.style.height = `${height}px`
    }
    const g = this.g
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    const css = getComputedStyle(document.documentElement)
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
    const line = v('--line', '#272c36')
    const ash = v('--ash', '#9ba1ab')
    const dim = v('--dim', '#6b7280')
    const red = v('--red', '#e8654f')
    const bone = v('--bone', '#ebe6dc')
    const font = '"Geist", "Inter", system-ui, sans-serif'
    const mono = '"Geist Mono", ui-monospace, monospace'

    const now = Date.now()
    const left = LABELS
    const right = width - 8
    const x = (t: number) => left + ((t - (now - SPAN_MS)) / SPAN_MS) * (right - left)
    const bottom = TOP + STATIONS.length * LANE

    // Minutes back from now, as faint lines with their numbers under the lanes.
    g.font = `400 10px ${mono}`
    g.textAlign = 'center'
    g.textBaseline = 'top'
    for (let m = 1; m <= 5; m++) {
      const at = Math.round(x(now - m * 60_000)) + 0.5
      g.strokeStyle = line
      g.globalAlpha = 0.5
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(at, TOP - 2)
      g.lineTo(at, bottom)
      g.stroke()
      g.globalAlpha = 1
      g.fillStyle = dim
      g.fillText(`−${m}m`, at, bottom + 5)
    }
    g.fillStyle = ash
    g.fillText('now', right - 8, bottom + 5)

    const entries = this.board?.entries ?? []
    STATIONS.forEach((s, i) => {
      const mid = TOP + i * LANE + LANE / 2
      const own = entries.filter(e => e.station === s.id && (e.endedAt ?? now) >= now - SPAN_MS)
      const used = (this.board?.counts[s.id] ?? 0) > 0
      g.font = `500 10.5px ${font}`
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      g.fillStyle = own.length > 0 ? bone : used ? ash : dim
      g.fillText(this.names?.[s.id] ?? s.id, left - 10, mid, left - 12)
      // The lane itself, faintly.
      g.strokeStyle = line
      g.globalAlpha = 0.35
      g.beginPath()
      g.moveTo(left, Math.round(mid) + 0.5)
      g.lineTo(right, Math.round(mid) + 0.5)
      g.stroke()
      g.globalAlpha = 1
      const colour = stationColor(s.id)
      for (const e of own) {
        const bad = e.status === 'err' || e.status === 'block'
        const from = Math.max(left, x(e.startedAt))
        const to = Math.min(right, x(e.endedAt ?? now))
        const w = Math.max(2, to - from)
        g.fillStyle = bad ? red : colour
        g.globalAlpha = e.status === 'run' ? 1 : 0.78
        g.beginPath()
        g.roundRect(from, mid - 3, w, 6, 3)
        g.fill()
      }
      g.globalAlpha = 1
    })

    // The answers: a fine mark across the lanes where Claude finished a turn.
    g.strokeStyle = bone
    g.globalAlpha = 0.25
    for (const e of entries) {
      if (e.mark !== 'done' || e.startedAt < now - SPAN_MS) continue
      const at = Math.round(x(e.startedAt)) + 0.5
      g.beginPath()
      g.moveTo(at, TOP - 2)
      g.lineTo(at, bottom)
      g.stroke()
    }
    g.globalAlpha = 1
    // Now.
    g.strokeStyle = ash
    g.beginPath()
    g.moveTo(right + 0.5, TOP - 2)
    g.lineTo(right + 0.5, bottom)
    g.stroke()

    this.timer = setTimeout(() => this.draw(), 1000)
  }
}

// SessionBrain's own station icons, drawn finer than lot-map's: one line weight, rounded joins, open
// shapes, all on the same 16-unit square around the station's centre.
//
// The scope (scope.ts) draws them with Path2D, scaled to the node.

import type { StationId } from './lot-map/types'

const ring = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

export const ICONS: Record<StationId, string> = {
  // A head and shoulders.
  you: `${ring(0, -3.2, 3)}M-6 7a6 5.2 0 0 1 12 0`,
  // The model thinking: a four-pointed spark, with a small one beside it.
  model: 'M-1 -7.5C-.4 -3.2 .9 -1.9 5 -1.3C.9 -.7 -.4 .6 -1 4.9C-1.6 .6 -2.9 -.7 -7 -1.3C-2.9 -1.9 -1.6 -3.2 -1 -7.5Z M5 3.2v4.4M2.8 5.4h4.4',
  // Memory: a stack of three layers.
  memory: 'M0 -7L7 -3.5L0 0L-7 -3.5Z M-7 0L0 3.5L7 0 M-7 3.5L0 7L7 3.5',
  // A page with a turned corner and two lines of text.
  files: 'M-5 -7.5h6.5l3.5 3.5v11.5h-10Z M1.5 -7.5v3.5h3.5 M-2.5 .5h5M-2.5 3.5h3.5',
  // A prompt and a cursor.
  shell: 'M-6.5 -4.5l4 4l-4 4 M.5 4.5h6',
  // A globe: the outline, the equator and one meridian.
  web: `${ring(0, 0, 7)}M-7 0h14 M0 -7a3.2 7 0 0 1 0 14a3.2 7 0 0 1 0 -14`,
  // A window with rounded corners and a title strip.
  browser: 'M-6 -6h12a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1 -1.5 1.5h-12a1.5 1.5 0 0 1 -1.5 -1.5v-9a1.5 1.5 0 0 1 1.5 -1.5Z M-7.5 -2.5h15 M-5 -4.25h.01M-3 -4.25h.01',
  // One node handing work to two.
  agents: `${ring(0, -5, 2.2)}${ring(-5.5, 5, 2.2)}${ring(5.5, 5, 2.2)}M0 -2.8v2.3M0 -.5L-4 3.4M0 -.5L4 3.4`,
  // A skill: a sharp bolt.
  skills: 'M1.2 -7.5L-4.8 1h4.3L-1.2 7.5L4.8 -1H.5Z',
  // A hook: a plug that fits into the session.
  hooks: 'M-2.5 -7.5v3.5M2.5 -7.5v3.5 M-5 -4h10v2a5 5 0 0 1 -10 0Z M0 3v4.5',
}


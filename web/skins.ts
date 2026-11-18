// Skins: whole palettes for the map and the page.
//
// lot-map takes colours by their place in its palette (`accent=#ff2bd6, background=#07060d`), so a
// skin is that list plus whether the map is dark or light. The page and the map read their colours
// from the CSS variables a skin sets (scope.ts adds its own colour for each activity).

import type { Setup } from './lot-map/map'

type Palette = Required<Setup['colors']>

export type SkinName = 'classic' | 'neon' | 'synthwave' | 'phosphor' | 'ice' | 'ember' | 'omarchy'

export type Skin = {
  label: string
  mode: 'dark' | 'light'
  palette: Palette
  /** Blur of the glow, in map units; 0 for none. */
  glow: number
}

export const SKIN_LABELS: Record<SkinName, string> = {
  classic: 'Classic (lot-map)',
  neon: 'Neon',
  synthwave: 'Synthwave',
  phosphor: 'Phosphor',
  ice: 'Ice',
  ember: 'Ember',
  omarchy: 'Omarchy (your desktop theme)',
}

const p = (
  ground: string, raised: string, line: string, spoke: string,
  bone: string, ash: string, dim: string,
  accent: string, hot: string, red: string, mem: string, memHot: string,
): Palette => ({ ground, raised, line, spoke, bone, ash, dim, accent, hot, red, mem, memHot, trail: bone })

export const SKINS: Record<Exclude<SkinName, 'classic' | 'omarchy'>, Skin> = {
  neon: {
    label: 'Neon', mode: 'dark', glow: 3.2,
    palette: p('#07060d', '#110e1f', '#2a2350', '#1a1533', '#f4f0ff', '#a99fd6', '#6b6296', '#ff2bd6', '#00f0ff', '#ff3864', '#39ff88', '#b6ffd6'),
  },
  synthwave: {
    label: 'Synthwave', mode: 'dark', glow: 2.8,
    palette: p('#140a24', '#1f1036', '#3d2466', '#2a1747', '#ffe9f7', '#c79fd8', '#8a6aa6', '#ff7edb', '#ffb86b', '#ff4f6d', '#72f1b8', '#c4ffe4'),
  },
  phosphor: {
    label: 'Phosphor', mode: 'dark', glow: 2.6,
    palette: p('#020a04', '#06140a', '#0f3a1a', '#0a2412', '#b8ffc8', '#5fd37a', '#2f8a46', '#33ff66', '#d4ff3c', '#ff5f3c', '#3cf0ff', '#b0fbff'),
  },
  ice: {
    label: 'Ice', mode: 'dark', glow: 2,
    palette: p('#070d16', '#0d1724', '#1f3550', '#142538', '#e8f6ff', '#8fb4cc', '#557891', '#5ad1ff', '#c2f0ff', '#ff6b81', '#a78bfa', '#ddd1ff'),
  },
  ember: {
    label: 'Ember', mode: 'dark', glow: 2.8,
    palette: p('#0e0806', '#1a0f0a', '#3a2015', '#26150e', '#ffeedd', '#c9a08a', '#8a6553', '#ff6a1a', '#ffc14d', '#ff2d3d', '#4fd1c5', '#b3f5ee'),
  },
}

/** A skin from the Omarchy theme's colors.toml fields (accent, background, foreground, red, …). */
export function omarchySkin(c: Record<string, string>): Skin | undefined {
  const pick = (...keys: string[]) => keys.map(k => c[k]).find(v => v !== undefined && /^#[0-9a-f]{6}$/i.test(v))?.toLowerCase()
  const ground = pick('darker_background', 'background')
  const bone = pick('bright_foreground', 'foreground')
  const accent = pick('accent', 'blue')
  if (ground === undefined || bone === undefined || accent === undefined) return undefined
  const raised = pick('dark_background', 'background') ?? ground
  const line = pick('lighter_background', 'selection', 'muted') ?? raised
  return {
    label: 'Omarchy',
    mode: c.mode === 'light' ? 'light' : 'dark',
    glow: c.mode === 'light' ? 0 : 2.2,
    palette: {
      ground, raised, line,
      spoke: pick('selection', 'lighter_background') ?? line,
      bone,
      ash: pick('foreground', 'light_foreground') ?? bone,
      dim: pick('dark_foreground', 'muted') ?? bone,
      accent,
      hot: pick('bright_cyan', 'cyan', 'yellow') ?? accent,
      red: pick('red', 'bright_red') ?? accent,
      mem: pick('green', 'bright_green') ?? accent,
      memHot: pick('bright_green', 'green') ?? accent,
      trail: bone,
    },
  }
}

/** The palette as lot-map's colour list, by the names it reads. */
const NAMES: Record<keyof Palette, string> = {
  ground: 'background', raised: 'node', line: 'line', spoke: 'spoke', bone: 'text', ash: 'label', dim: 'faint',
  accent: 'accent', hot: 'active', red: 'error', mem: 'memory', memHot: 'memoryActive', trail: 'route',
}
export const colorList = (pal: Palette) => (Object.keys(NAMES) as (keyof Palette)[]).map(k => `${NAMES[k]}=${pal[k]}`).join(',')

/** The page's own colours (the bar, the list, the dialog) set from a skin, or cleared for classic. */
export function paintPage(skin: Skin | undefined) {
  const root = document.documentElement.style
  const vars: Record<string, keyof Palette> = {
    '--ground': 'ground', '--raised': 'raised', '--line': 'line', '--bone': 'bone', '--ash': 'ash',
    '--dim': 'dim', '--accent': 'accent', '--hot': 'hot', '--red': 'red', '--mem': 'mem',
  }
  for (const [v, k] of Object.entries(vars)) {
    if (skin === undefined) root.removeProperty(v)
    else root.setProperty(v, skin.palette[k])
  }
  if (skin === undefined) root.removeProperty('color-scheme')
  else root.setProperty('color-scheme', skin.mode)
}

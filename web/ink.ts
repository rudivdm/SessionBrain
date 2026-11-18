// The ink: a WebGL field in which every call blooms in its activity's colour and spreads like ink in
// water. A slow current turns the ink and draws it in towards Claude at the centre; old ink fades.
//
// The simulation runs on the GPU at a fraction of the screen's resolution (ink is soft, so it does not
// need more) and is shown full size. It runs at 30 frames a second while anything happens, slower while
// ink is only drifting, and stops once the field is still, since every frame costs the window a repaint.

const VERTEX = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`

const NOISE = `
vec3 hash3(vec3 p) { p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx) * 2. - 1.; }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(mix(dot(hash3(i), f), dot(hash3(i + vec3(1, 0, 0)), f - vec3(1, 0, 0)), u.x),
                 mix(dot(hash3(i + vec3(0, 1, 0)), f - vec3(0, 1, 0)), dot(hash3(i + vec3(1, 1, 0)), f - vec3(1, 1, 0)), u.x), u.y),
             mix(mix(dot(hash3(i + vec3(0, 0, 1)), f - vec3(0, 0, 1)), dot(hash3(i + vec3(1, 0, 1)), f - vec3(1, 0, 1)), u.x),
                 mix(dot(hash3(i + vec3(0, 1, 1)), f - vec3(0, 1, 1)), dot(hash3(i + vec3(1, 1, 1)), f - vec3(1, 1, 1)), u.x), u.y), u.z);
}
vec2 curl(vec2 p, float t) {
  float e = .01;
  return vec2(noise(vec3(p.x, p.y + e, t)) - noise(vec3(p.x, p.y - e, t)), -(noise(vec3(p.x + e, p.y, t)) - noise(vec3(p.x - e, p.y, t)))) / (2. * e);
}`

// Moves the ink one step along the current, lets it spread a little into its neighbours, and fades it.
const ADVECT = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D ink; uniform float time, dt, aspect, fade, flow; uniform vec2 texel, centre;
${NOISE}
void main() {
  vec2 q = vec2(uv.x * aspect, uv.y);
  vec2 c = vec2(centre.x * aspect, centre.y);
  vec2 toCentre = c - q;
  float d = length(toCentre) + 1e-4;
  // A slow turning current, a gentle swirl round the centre, and a faint pull in towards it.
  vec2 v = curl(q * 2.0, time * .045) * .0055 + curl(q * 5.5, time * .09) * .0022
         + vec2(-toCentre.y, toCentre.x) / d * .0009 + toCentre * .0016;
  vec2 from = uv - v * dt * flow * vec2(1. / aspect, 1.);
  vec4 here = texture(ink, from);
  vec4 around = texture(ink, from + vec2(texel.x, 0.)) + texture(ink, from - vec2(texel.x, 0.))
              + texture(ink, from + vec2(0., texel.y)) + texture(ink, from - vec2(0., texel.y));
  o = mix(here, around * .25, .18 * min(dt, 3.) * flow) * (1. - fade * dt);
}`

// Adds a drop of ink: colour and amount, a soft round blot with a slightly uneven edge.
const DROP = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D ink; uniform vec2 at; uniform vec3 colour; uniform float amount, radius, aspect, seed;
${NOISE}
void main() {
  vec2 d = (uv - at) * vec2(aspect, 1.);
  float edge = 1. + .35 * noise(vec3(d * 18., seed));
  float g = exp(-dot(d, d) / (radius * radius * edge)) * amount;
  o = texture(ink, uv) + vec4(colour * g, g);
}`

// Shows the ink on the ground: luminous on a dark ground, absorbed like ink on paper on a light one,
// with its edges a little stronger, as ink and watercolour dry.
const SHOW = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D ink; uniform vec3 ground; uniform float dark; uniform vec2 texel;
uniform vec2 size; uniform float scale;
uniform sampler2D plate; uniform vec2 plateAt, plateScale, plateSize;
uniform int links; uniform vec4 linkEnds[16]; uniform vec4 linkColour[16]; uniform vec2 linkFlow[16]; uniform float time; uniform vec3 restLine;
uniform int signals; uniform vec4 signalAt[32]; uniform vec4 signalColour[32]; uniform vec2 signalTail[32];
float toSegment(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
void main() {
  vec4 c = texture(ink, uv);
  float a = c.a;
  vec3 hue = c.rgb / max(a, 1e-4);
  float edge = length(vec2(texture(ink, uv + vec2(texel.x * 1.5, 0.)).a - texture(ink, uv - vec2(texel.x * 1.5, 0.)).a,
                           texture(ink, uv + vec2(0., texel.y * 1.5)).a - texture(ink, uv - vec2(0., texel.y * 1.5)).a));
  // The plate under it all (rendered in Blender, art/render.py): grey, 50% the theme's ground, lighter
  // in the pool of light round Claude, fading to the plain ground at the edges of the art.
  vec2 px = uv * size;
  vec2 pp = ((px - plateAt) * plateScale + plateSize * .5) / plateSize;
  float pv = texture(plate, pp).r;
  float inside = min(min(px.x, size.x - px.x), min(px.y, size.y - px.y));
  pv = mix(.5, pv, smoothstep(0., 90. * scale, inside));
  vec3 g = ground * (1. + (pv - .5) * mix(.18, .9, dark));
  float body = 1. - exp(-a * 1.35);
  float rim = clamp(edge * 2.2, 0., .5);
  // Kept faint: the ink is the background, under the nodes, lines and words.
  vec3 lit = g + hue * (body * .34 + rim * .16);
  vec3 paper = g * exp(-(a + rim * .6) * (1. - hue) * .75) * (1. - body * .03);
  vec3 colour = mix(paper, lit, dark);
  // The lines between Claude and each activity: hairlines at rest, in the activity's colour while live.
  for (int i = 0; i < 16; i++) {
    if (i >= links) break;
    vec4 c = linkColour[i];
    float worn = linkFlow[i].y;
    float d = toSegment(px, linkEnds[i].xy, linkEnds[i].zw);
    // Every line is always there, in its activity's colour, and wears in with use, as lot-map's spokes
    // do: by the end of a session the map shows where the work went. Lit, it takes its full colour.
    float width = (.6 + .9 * worn + .6 * c.a) * scale;
    float line = 1. - smoothstep(width - .6 * scale, width + .7 * scale, d);
    vec3 tint = mix(mix(restLine, c.rgb, .3 + .4 * worn), c.rgb, c.a);
    colour = mix(colour, tint, line * (.65 + .35 * c.a));
    colour += c.rgb * c.a * .22 * exp(-d / (5. * scale)) * dark;
    // While a line is lit, short dashes flow along it: out to the activity while a call runs, back
    // to Claude as the answer comes in, slowing and fading with the line.
    if (c.a > .01) {
      vec2 ab = linkEnds[i].zw - linkEnds[i].xy;
      float len = max(length(ab), 1.);
      float along = dot(px - linkEnds[i].xy, ab) / len;
      float period = 18. * scale;
      float phase = fract((along - linkFlow[i].x * time * (24. + 40. * c.a) * scale) / period);
      float dash = smoothstep(0., .12, phase) * (1. - smoothstep(.3, .42, phase));
      float ends = smoothstep(0., 14. * scale, along) * smoothstep(0., 14. * scale, len - along);
      float core = 1. - smoothstep(1.1 * scale, 2.1 * scale, d);
      colour = mix(colour, mix(c.rgb, vec3(1.), .35 * dark), core * dash * ends * c.a * .9);
    }
  }
  // Signals: a bright point with a soft halo travelling along a line.
  for (int i = 0; i < 32; i++) {
    if (i >= signals) break;
    vec4 at = signalAt[i];
    vec4 c = signalColour[i];
    float d = length(px - at.xy);
    float r = at.z * scale;
    // Its tail: a short streak behind it, fading back along the way it came.
    vec2 ta = signalTail[i], tb = at.xy - ta;
    float h = clamp(dot(px - ta, tb) / max(dot(tb, tb), 1e-4), 0., 1.);
    float td = length(px - ta - tb * h);
    float tail = (1. - smoothstep(r * .22, r * .5, td)) * h * h * c.a;
    colour = mix(colour, c.rgb, tail * .85);
    float halo = exp(-(d * d) / (r * r * 4.)) * c.a;
    float core = (1. - smoothstep(r * .45, r * .7, d)) * c.a;
    colour = mix(colour, c.rgb, halo * mix(.35, .55, dark));
    colour += c.rgb * halo * .5 * dark;
    colour = mix(colour, mix(c.rgb, vec3(1.), .55 * dark), core);
  }
  o = vec4(colour, 1.);
}`

type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer }

function rgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = Number.parseInt(h.slice(0, 6), 16)
  return Number.isNaN(n) ? [0.5, 0.5, 0.5] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export type Drop = { x: number; y: number; colour: string; amount: number; radius?: number }
type Point = { x: number; y: number }
/** A line between two places (fractions of the width and height, y from the top); lit while its activity is in use. */
export type Link = { from: Point; to: Point; colour: string; rest: string; running: boolean; lastAt: number; worn?: number }
/** A call travelling straight along a line, and the drop it leaves where it lands. */
type Signal = { from: Point; to: Point; colour: string; size: number; start: number; duration: number; lane: number; land?: Drop }
/** A running call: ink keeps gathering where it runs, and a signal goes out to it every so often. */
export type Feed = { from: Point; to: Point; colour: string; amount: number; key: string }

const easeInOut = (t: number) => t * t * (3 - 2 * t)
const SIGNAL_EVERY_MS = 1300
/** How long a line stays lit after its activity's last call. */
const LIT_MS = 6000

export class InkField {
  private gl: WebGL2RenderingContext
  private advect: Program
  private drop: Program
  private show: Program
  private quad: WebGLBuffer
  private a: Target | undefined
  private b: Target | undefined
  private simW = 0
  private simH = 0
  private float: boolean
  private ground: [number, number, number] = [0.04, 0.05, 0.07]
  private dark = 1
  private centre: [number, number] = [0.5, 0.5]
  /** The plate, its size in pixels, and the radius of the ring of activities it is laid out for. */
  private plate: WebGLTexture
  private plateSize: [number, number] = [1, 1]
  private ring = 240
  private pending: Drop[] = []
  private feeds: Feed[] = []
  private links: Link[] = []
  private signals: Signal[] = []
  private lastSignal = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private visible = true
  private last = 0
  private start = performance.now()
  /** When ink last went in; the field is drawn until it has had time to settle after that. */
  private lastDrop = -Infinity
  private motion = !matchMedia('(prefers-reduced-motion: reduce)').matches

  /** A WebGL2 context, or undefined where there is none (the page then draws the diagram instead). */
  static create(canvas: HTMLCanvasElement): InkField | undefined {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' })
    if (gl === null) return undefined
    try {
      return new InkField(canvas, gl)
    } catch {
      return undefined
    }
  }

  private constructor(private canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl
    this.float = gl.getExtension('EXT_color_buffer_float') !== null || gl.getExtension('EXT_color_buffer_half_float') !== null
    this.advect = this.compile(ADVECT)
    this.drop = this.compile(DROP)
    this.show = this.compile(SHOW)
    this.quad = gl.createBuffer() as WebGLBuffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    // Plain ground (50% grey) until the plate has loaded, or if it never does.
    this.plate = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, this.plate)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]))
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, k as number, v as number)
    }
    const img = new Image()
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, this.plate)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
      this.plateSize = [img.naturalWidth, img.naturalHeight]
      this.wake()
    }
    img.src = 'art/plate.webp'
  }

  private compile(fragment: string): Program {
    const gl = this.gl
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type) as WebGLShader
      gl.shaderSource(s, source)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const program = gl.createProgram() as WebGLProgram
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link')
    const uniforms: Program['uniforms'] = {}
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)
      if (info !== null) uniforms[info.name] = gl.getUniformLocation(program, info.name)
    }
    return { program, uniforms }
  }

  private target(): Target {
    const gl = this.gl
    const texture = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, this.float ? gl.RGBA16F : gl.RGBA8, this.simW, this.simH, 0, gl.RGBA, this.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null)
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, k as number, v as number)
    }
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return { texture, framebuffer }
  }

  /** Sizes the canvas to its box (CSS pixels); the ink starts over at the new size. */
  resize(width: number, height: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    if (w === this.canvas.width && h === this.canvas.height && this.a !== undefined) return
    this.canvas.width = w
    this.canvas.height = h
    // Ink is soft: a third of the screen's pixels is plenty, and keeps the GPU's work small.
    const scale = Math.min(0.36, 720 / w)
    this.simW = Math.max(16, Math.round(w * scale))
    this.simH = Math.max(16, Math.round(h * scale))
    for (const t of [this.a, this.b]) {
      if (t === undefined) continue
      this.gl.deleteTexture(t.texture)
      this.gl.deleteFramebuffer(t.framebuffer)
    }
    this.a = this.target()
    this.b = this.target()
    this.wake()
  }

  setGround(hex: string, dark: boolean) {
    this.ground = rgb(hex)
    this.dark = dark ? 1 : 0
    this.wake()
  }

  /** Where the current draws the ink to, as a fraction of the width and height (y from the top). */
  setCentre(x: number, y: number) {
    this.centre = [x, 1 - y]
  }

  /** The radius of the ring of activities, in CSS pixels: the plate is scaled to it. */
  setRing(r: number) {
    this.ring = Math.max(40, r)
    this.wake()
  }

  /** A drop of ink, at a fraction of the width and height (y from the top). */
  add(d: Drop) {
    this.pending.push(d)
    this.lastDrop = performance.now()
    this.wake()
  }

  /** The lines between Claude and the activities. */
  setLinks(links: Link[]) {
    this.links = links.slice(0, 16)
    this.wake()
  }

  /** A call travelling straight from one place to another, landing as `land` (a bloom) when it arrives. */
  signal(from: Point, to: Point, colour: string, size = 1, duration = 650, land?: Drop, delay = 0) {
    const now = performance.now()
    // Calls that share a line and a moment fly side by side, a little apart in time, as lot-map's
    // pulses do, so five parallel calls read as five, not one.
    const same = (q: Point, r: Point) => Math.abs(q.x - r.x) < 1e-3 && Math.abs(q.y - r.y) < 1e-3
    const peers = this.signals.filter(s => same(s.from, from) && same(s.to, to) && s.start + s.duration * 0.6 > now + delay).length
    const lane = peers === 0 ? 0 : (peers % 2 === 1 ? 1 : -1) * Math.ceil(peers / 2) * 6
    this.signals.push({ from, to, colour, size, start: now + delay + Math.min(peers, 4) * 90, duration, lane, land })
    if (this.signals.length > 32) this.signals.splice(0, this.signals.length - 32)
    this.lastDrop = performance.now()
    this.wake()
  }

  /** Calls running now: ink gathers where each runs, and a signal goes out to it every second or so. */
  setFeeds(feeds: Feed[]) {
    this.feeds = feeds
    for (const key of [...this.lastSignal.keys()]) if (!feeds.some(f => f.key === key)) this.lastSignal.delete(key)
    if (feeds.length > 0) {
      this.lastDrop = performance.now()
      this.wake()
    }
  }

  setVisible(v: boolean) {
    this.visible = v
    if (v) this.wake()
    else if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private wake() {
    if (this.timer === undefined && this.visible) this.timer = setTimeout(() => this.tick(), 0)
  }

  private tick() {
    this.timer = undefined
    if (!this.visible || this.a === undefined) return
    const now = performance.now()
    const quiet = now - this.lastDrop
    this.frame(now)
    // Thirty frames a second just after something happens, eight while the ink drifts, none once it has settled.
    const pace = !this.motion ? (quiet < 90_000 ? 1000 : 0) : this.feeds.length > 0 || this.signals.length > 0 || this.links.some(l => l.running || Date.now() - l.lastAt < LIT_MS) || quiet < 15_000 ? 33 : quiet < 90_000 ? 125 : 0
    if (pace > 0) this.timer = setTimeout(() => this.tick(), pace)
  }

  private pass(p: Program, to: Target | undefined, set: (u: Program['uniforms']) => void) {
    const gl = this.gl
    gl.useProgram(p.program)
    const at = gl.getAttribLocation(p.program, 'p')
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, to === undefined ? null : to.framebuffer)
    gl.viewport(0, 0, to === undefined ? this.canvas.width : this.simW, to === undefined ? this.canvas.height : this.simH)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, (this.a as Target).texture)
    gl.uniform1i(p.uniforms.ink ?? null, 0)
    set(p.uniforms)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private swap() {
    ;[this.a, this.b] = [this.b, this.a]
  }

  private frame(now: number) {
    const gl = this.gl
    const dt = this.last === 0 ? 1 : Math.min(4, (now - this.last) / 16.67)
    this.last = now
    const aspect = this.simW / this.simH
    const drops: Drop[] = [...this.pending, ...this.feeds.map(f => ({ colour: f.colour, radius: 0.045, amount: f.amount * dt, x: f.to.x + (Math.random() - 0.5) * 0.012, y: f.to.y + (Math.random() - 0.5) * 0.012 }))]
    this.pending = []
    // A running call sends a signal out to where it runs every so often, so its line stays alive.
    for (const f of this.feeds) {
      if (now - (this.lastSignal.get(f.key) ?? 0) < SIGNAL_EVERY_MS) continue
      this.lastSignal.set(f.key, now)
      this.signal(f.from, f.to, f.colour, 1, 800)
    }
    // Signals that have arrived leave their drop and go.
    for (const s of [...this.signals]) {
      if (now - s.start < s.duration) continue
      if (s.land !== undefined) drops.push(s.land)
      this.signals.splice(this.signals.indexOf(s), 1)
    }
    for (const d of drops) {
      const [r, g, b] = rgb(d.colour)
      this.pass(this.drop, this.b, u => {
        gl.uniform2f(u.at ?? null, d.x, 1 - d.y)
        gl.uniform3f(u.colour ?? null, r, g, b)
        gl.uniform1f(u.amount ?? null, d.amount)
        gl.uniform1f(u.radius ?? null, d.radius ?? 0.04)
        gl.uniform1f(u.aspect ?? null, aspect)
        gl.uniform1f(u.seed ?? null, Math.random() * 100)
      })
      this.swap()
    }
    this.pass(this.advect, this.b, u => {
      gl.uniform1f(u.time ?? null, (now - this.start) / 1000)
      gl.uniform1f(u.dt ?? null, dt)
      // With reduced motion the ink still fades, but does not flow.
      gl.uniform1f(u.flow ?? null, this.motion ? 1 : 0)
      gl.uniform1f(u.aspect ?? null, aspect)
      // Ink fades by half in about twenty seconds; 8-bit ink needs to fade faster or it never clears.
      gl.uniform1f(u.fade ?? null, this.float ? 0.0006 : 0.0016)
      gl.uniform2f(u.texel ?? null, 1 / this.simW, 1 / this.simH)
      gl.uniform2f(u.centre ?? null, this.centre[0], this.centre[1])
    })
    this.swap()
    const W = this.canvas.width
    const H = this.canvas.height
    const px = (p: Point) => [p.x * W, (1 - p.y) * H]
    const wall = Date.now()
    const ends = new Float32Array(64)
    const colours = new Float32Array(64)
    const flows = new Float32Array(32)
    this.links.forEach((l, i) => {
      const lit = l.running ? 1 : Math.max(0, 1 - (wall - l.lastAt) / LIT_MS)
      ends.set([...px(l.from), ...px(l.to)], i * 4)
      colours.set([...rgb(l.colour), lit], i * 4)
      // Outwards while the call runs, back once its answer is in; and how worn the line is.
      flows.set([l.running ? 1 : -1, l.worn ?? 0], i * 2)
    })
    const at = new Float32Array(128)
    const tints = new Float32Array(128)
    const tails = new Float32Array(64)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    // Only signals that have set off are drawn; one held back to follow another waits its turn.
    const flying = this.signals.filter(s => now >= s.start)
    flying.forEach((s, i) => {
      const raw = Math.min(1, (now - s.start) / s.duration)
      const along = (t: number) => {
        const [x0, y0] = px(s.from)
        const [x1, y1] = px(s.to)
        const len = Math.hypot(x1 - x0, y1 - y0) || 1
        const k = s.lane * dpr
        return [x0 + (x1 - x0) * t - ((y1 - y0) / len) * k, y0 + (y1 - y0) * t + ((x1 - x0) / len) * k]
      }
      // Signals fade in as they leave and out as they arrive.
      const fade = Math.min(1, raw * 6, (1 - raw) * 6 + 0.25)
      at.set([...along(easeInOut(raw)), 5.5 * s.size, 0], i * 4)
      tails.set(along(easeInOut(Math.max(0, raw - 0.22))), i * 2)
      tints.set([...rgb(s.colour), fade], i * 4)
    })
    this.pass(this.show, undefined, u => {
      gl.uniform3f(u.ground ?? null, ...this.ground)
      // The plate's dais (250 of its pixels across, as art/render.py draws it) sits under Claude at
      // a little under half the ring's radius, stretched sideways as the ring is.
      const k = 250 / (0.45 * this.ring * dpr)
      gl.uniform2f(u.plateAt ?? null, this.centre[0] * W, this.centre[1] * H)
      gl.uniform2f(u.plateScale ?? null, k / 1.18, k)
      gl.uniform2f(u.plateSize ?? null, ...this.plateSize)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.plate)
      gl.uniform1i(u.plate ?? null, 1)
      gl.activeTexture(gl.TEXTURE0)
      gl.uniform1f(u.dark ?? null, this.dark)
      gl.uniform2f(u.texel ?? null, 1 / this.simW, 1 / this.simH)
      gl.uniform2f(u.size ?? null, W, H)
      gl.uniform1f(u.scale ?? null, dpr)
      gl.uniform1i(u.links ?? null, this.links.length)
      gl.uniform4fv(u['linkEnds[0]'] ?? null, ends)
      gl.uniform4fv(u['linkColour[0]'] ?? null, colours)
      gl.uniform2fv(u['linkFlow[0]'] ?? null, flows)
      gl.uniform3f(u.restLine ?? null, ...rgb(this.links[0]?.rest ?? '#272c36'))
      // Seconds, wrapped so the shader keeps its precision; still dashes with reduced motion.
      gl.uniform1f(u.time ?? null, this.motion ? (now % 600_000) / 1000 : 0)
      gl.uniform1i(u.signals ?? null, flying.length)
      gl.uniform4fv(u['signalAt[0]'] ?? null, at)
      gl.uniform4fv(u['signalColour[0]'] ?? null, tints)
      gl.uniform2fv(u['signalTail[0]'] ?? null, tails)
    })
  }
}

// Runs the real hub (the Rust sessionbrain-app) on a spare port with its own folders of session files
// and transcripts and a fake `claude agents`, and drives it the way Claude Code and a page do:
// sessions open and close, transcripts grow, a page follows along.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const dir = mkdtempSync(join(tmpdir(), 'sessionbrain-test-'))
const agents = join(dir, 'agents.json')
const sessionsDir = join(dir, 'sessions')
const projectsDir = join(dir, 'projects')
const HUB = [process.env.SESSIONBRAIN_HUB ?? join(ROOT, 'app', 'target', 'release', 'sessionbrain-app'), 'hub']
const stat = readFileSync('/proc/self/stat', 'utf8')
const procStart = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
const port = 20000 + Math.floor(Math.random() * 20000)
const base = `http://127.0.0.1:${port}`
let hub: ReturnType<typeof Bun.spawn>

// Each hub here runs with this key; requests carry it as the sessionbrain command does.
const KEY = 'test-key-0123456789abcdef0123456789abcdef'
const keyed = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-SessionBrain-Key': KEY } })

const CWD = '/home/u/proj'
const folder = join(projectsDir, '-home-u-proj')
const transcript = (id: string) => join(folder, `${id}.jsonl`)
const iso = (ms = Date.now()) => new Date(ms).toISOString()

// Records shaped as Claude Code writes them (conversation records start with parentUuid).
const line = (r: Record<string, unknown>) => `${JSON.stringify({ parentUuid: null, isSidechain: false, ...r, timestamp: iso() })}\n`
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })
const step = (req: string, tools: { id: string; name: string; input: Record<string, unknown> }[] = [], agentId?: string) =>
  line({
    ...(agentId ? { isSidechain: true, agentId } : {}),
    requestId: req,
    message: { model: 'claude-opus-5-5', stop_reason: tools.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 30_000 }, content: [{ type: 'text', text: 'private words' }, ...tools.map(t => ({ type: 'tool_use', ...t }))] },
    type: 'assistant',
  })
const result = (id: string, err = false) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: 'private output' }] } })
const end = () => line({ type: 'system', subtype: 'turn_duration', durationMs: 5 })

/** This test's own process stands in for an open Claude session. */
function openSession(id: string, name: string) {
  writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ pid: process.pid, procStart, sessionId: id, kind: 'interactive', name, cwd: CWD, status: 'busy', startedAt: Date.now() }))
}

mkdirSync(sessionsDir)
mkdirSync(folder, { recursive: true })
openSession('sess-open', 'proj-3f')
writeFileSync(transcript('sess-open'), `{"type":"ai-title","aiTitle":"x"}\n${prompt('hello')}${step('r1', [{ id: 't1', name: 'Read', input: { file_path: '/home/u/proj/a.ts' } }])}`)
writeFileSync(agents, JSON.stringify([{ sessionId: 'from-agents', kind: 'interactive', name: 'agents-1', cwd: '/home/u/other', status: 'busy', pid: 1, startedAt: Date.now() }]))

type Summary = { sessionId: string; feed: string; name: string; model?: string; context?: number; running: number; activity?: string }
type Rec = { k: string; at: number; agent?: string; tools?: { name: string }[]; results?: { id: string; err?: boolean }[] }

/** Follows the page stream and keeps what it hears. */
function follow(session?: string) {
  const ctrl = new AbortController()
  const heard = { sessions: [] as Summary[][], views: [] as { session: Summary; records: Rec[] }[], records: [] as Rec[] }
  const done = (async () => {
    const res = await keyed(`${base}/stream${session ? `?session=${session}` : ''}`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += dec.decode(value)
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const event = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (!data) continue
        if (event === 'sessions') heard.sessions.push(JSON.parse(data))
        if (event === 'view') heard.views.push(JSON.parse(data))
        if (event === 'records') heard.records.push(...JSON.parse(data).records)
      }
    }
  })().catch(() => {})
  return { heard, stop: async () => (ctrl.abort(), await done) }
}

async function until(check: () => boolean, ms = 5000) {
  for (let t = 0; t < ms && !check(); t += 25) await Bun.sleep(25)
  expect(check()).toBe(true)
}

beforeAll(async () => {
  hub = Bun.spawn(HUB, {
    env: { ...process.env, SESSIONBRAIN_KEY: KEY, SESSIONBRAIN_PORT: String(port), SESSIONBRAIN_SESSIONS_DIR: sessionsDir, SESSIONBRAIN_PROJECTS_DIR: projectsDir, SESSIONBRAIN_CLAUDE: join(ROOT, 'test', 'fake-claude.sh'), FAKE_AGENTS: agents },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  for (let i = 0; i < 100; i++) {
    if (await keyed(`${base}/healthz`).then(r => r.ok).catch(() => false)) return
    await Bun.sleep(100)
  }
  throw new Error('hub did not start')
})

afterAll(() => {
  hub.kill()
  rmSync(dir, { recursive: true, force: true })
})

test('the page, its script and its icon are served', async () => {
  const html = await keyed(`${base}/`).then(r => r.text())
  expect(html).toContain('<script type="module" src="/app.js">')
  const js = await keyed(`${base}/app.js`)
  expect(js.headers.get('content-type')).toContain('javascript')
  expect((await js.text()).length).toBeGreaterThan(10_000)
  expect((await keyed(`${base}/icon.svg`)).ok).toBe(true)
})

test('without this account\'s key nothing but the health check is answered; the key in the address leaves a cookie', async () => {
  expect((await fetch(`${base}/healthz`)).status).toBe(200)
  for (const path of ['/', '/app.js', '/api/sessions', '/api/view?session=sess-open', '/stream']) {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(403)
  }
  expect((await fetch(`${base}/api/sessions`, { headers: { 'X-SessionBrain-Key': 'wrong' } })).status).toBe(403)
  expect((await fetch(`${base}/api/sessions?key=${KEY.slice(0, -1)}x`)).status).toBe(403)
  const page = await fetch(`${base}/?session=sess-open&key=${KEY}`)
  expect(page.status).toBe(200)
  const cookie = page.headers.get('set-cookie') ?? ''
  expect(cookie).toContain(`sessionbrain${port}=${KEY}`)
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  // The page's own requests then carry only the cookie.
  expect((await fetch(`${base}/api/sessions`, { headers: { Cookie: cookie.split(';')[0] } })).status).toBe(200)
})

test('a request under another host name is refused (DNS rebinding)', async () => {
  const res = await keyed(`${base}/api/sessions`, { headers: { host: 'evil.example:80' } })
  expect(res.status).toBe(403)
})

test('an open session is listed with what its transcript says, before any page asked', async () => {
  const list = (await keyed(`${base}/api/sessions`).then(r => r.json())) as Summary[]
  expect(list).toEqual([expect.objectContaining({ sessionId: 'sess-open', name: 'proj-3f', feed: 'live', model: 'claude-opus-5-5', context: 15, running: 1, activity: 'busy' })])
})

test('a page following a session gets its records, then each new line as it is written', async () => {
  const page = follow('sess-open')
  await until(() => page.heard.views.length === 1)
  const first = page.heard.views[0]!
  expect(first.records.map(r => r.k)).toEqual(['prompt', 'step'])
  expect(JSON.stringify(first)).not.toContain('private')

  appendFileSync(transcript('sess-open'), result('t1') + step('r2', [{ id: 't2', name: 'Bash', input: { command: 'make', description: 'Build' } }]))
  await until(() => page.heard.records.length >= 2)
  expect(page.heard.records.map(r => r.k)).toEqual(['results', 'step'])

  // A line arriving in two pieces is taken once it is whole.
  const whole = result('t2', true)
  appendFileSync(transcript('sess-open'), whole.slice(0, 40))
  await Bun.sleep(600)
  expect(page.heard.records.length).toBe(2)
  appendFileSync(transcript('sess-open'), whole.slice(40))
  await until(() => page.heard.records.length === 3)
  expect(page.heard.records[2]?.results?.[0]).toEqual({ id: 't2', err: true })

  // A subagent's transcript beside the session's.
  mkdirSync(join(folder, 'sess-open', 'subagents'), { recursive: true })
  writeFileSync(join(folder, 'sess-open', 'subagents', 'agent-a1.jsonl'), step('q1', [{ id: 's1', name: 'Grep', input: {} }], 'a1'))
  await until(() => page.heard.records.some(r => r.agent === 'a1'))

  appendFileSync(transcript('sess-open'), step('r3') + end())
  await until(() => page.heard.records.some(r => r.k === 'end'))
  await page.stop()
})

test('a new line reaches the page as fast as the terminal shows it (well under the 400 ms backstop poll)', async () => {
  const page = follow('sess-open')
  await until(() => page.heard.views.length === 1)
  await Bun.sleep(450) // just after a backstop poll, so only the file watch can be fast
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const before = page.heard.records.length
    const t = performance.now()
    appendFileSync(transcript('sess-open'), prompt(`quick ${i}`))
    await until(() => page.heard.records.length > before)
    times.push(performance.now() - t)
    await Bun.sleep(120)
  }
  times.sort((a, b) => a - b)
  expect(times[2]).toBeLessThan(100)
  await page.stop()
})

test('a request to switch the window reaches open pages, but only with the SessionBrain header', async () => {
  const res = await keyed(`${base}/stream`)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let text = ''
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      text += dec.decode(value)
    }
  })().catch(() => {})
  await until(() => text.includes('event: sessions'))
  // A web page could send this without the header; it is refused.
  expect((await keyed(`${base}/api/show?session=sess-open`, { method: 'POST' })).status).toBe(400)
  expect((await keyed(`${base}/api/show?session=../x`, { method: 'POST', headers: { 'X-SessionBrain': '1' } })).status).toBe(400)
  expect((await keyed(`${base}/api/show?session=sess-open`, { method: 'POST', headers: { 'X-SessionBrain': '1' } })).status).toBe(204)
  await until(() => /event: show\ndata: sess-open/.test(text))
  await reader.cancel()
  await reading
})

test('garbage in a transcript is skipped and the hub goes on', async () => {
  const page = follow('sess-open')
  await until(() => page.heard.views.length === 1)
  appendFileSync(transcript('sess-open'), `not json at all\n{"type":"assistant"}\n${'x'.repeat(200_000)}\n\u0000\u0001\n${prompt('still here')}`)
  await until(() => page.heard.records.some(r => r.k === 'prompt'))
  expect((await keyed(`${base}/healthz`)).ok).toBe(true)
  await page.stop()
})

test('a transcript that starts over is sent whole again', async () => {
  const page = follow('sess-open')
  await until(() => page.heard.views.length === 1)
  writeFileSync(transcript('sess-open'), prompt('fresh'))
  await until(() => page.heard.views.length === 2)
  expect(page.heard.views[1]!.records.map(r => r.k)).toEqual(['prompt'])
  await page.stop()
})

test('a session opened later is found, and one that closes reads as ended', async () => {
  const page = follow()
  await until(() => page.heard.sessions.length >= 1)
  openSession('sess-late', 'late-1')
  await until(() => page.heard.sessions.at(-1)?.some(s => s.sessionId === 'sess-late' && s.feed === 'nofeed') ?? false)
  writeFileSync(transcript('sess-late'), prompt('hi'))
  await until(() => page.heard.sessions.at(-1)?.some(s => s.sessionId === 'sess-late' && s.feed === 'live') ?? false)
  unlinkSync(join(sessionsDir, 'sess-late.json'))
  await until(() => page.heard.sessions.at(-1)?.some(s => s.sessionId === 'sess-late' && s.feed === 'ended') ?? false)
  // Open sessions come first.
  expect(page.heard.sessions.at(-1)?.[0]?.sessionId).toBe('sess-open')
  await page.stop()
}, 20_000)

test('a session nobody knows is answered as missing', async () => {
  const res = await keyed(`${base}/api/view?session=nope`)
  expect(res.status).toBe(404)
  const page = follow('nope')
  await until(() => page.heard.views.length === 1)
  expect(page.heard.views[0]).toEqual({ missing: 'nope' } as never)
  await page.stop()
})

test('a second hub on the same port refuses to start and leaves the first alone', async () => {
  const second = Bun.spawn(HUB, {
    env: { ...process.env, SESSIONBRAIN_KEY: KEY, SESSIONBRAIN_PORT: String(port), SESSIONBRAIN_SESSIONS_DIR: sessionsDir, SESSIONBRAIN_PROJECTS_DIR: projectsDir },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  expect(await second.exited).toBe(1)
  expect(await new Response(second.stderr).text()).toContain('another SessionBrain hub')
  expect((await keyed(`${base}/healthz`)).ok).toBe(true)
})

test('without session files the hub falls back to `claude agents`', async () => {
  const otherPort = port + 2
  const other = Bun.spawn(HUB, {
    env: { ...process.env, SESSIONBRAIN_KEY: KEY, SESSIONBRAIN_PORT: String(otherPort), SESSIONBRAIN_SESSIONS_DIR: join(dir, 'missing'), SESSIONBRAIN_PROJECTS_DIR: projectsDir, SESSIONBRAIN_CLAUDE: join(ROOT, 'test', 'fake-claude.sh'), FAKE_AGENTS: agents },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    for (let i = 0; i < 100; i++) {
      if (await keyed(`http://127.0.0.1:${otherPort}/healthz`).then(r => r.ok).catch(() => false)) break
      await Bun.sleep(50)
    }
    const list = (await keyed(`http://127.0.0.1:${otherPort}/api/sessions`).then(r => r.json())) as Summary[]
    expect(list).toEqual([expect.objectContaining({ sessionId: 'from-agents', name: 'agents-1', activity: 'busy', feed: 'nofeed' })])
  } finally {
    other.kill()
  }
})

test('with no Claude folders at all the hub still runs and lists nothing', async () => {
  const otherPort = port + 3
  const other = Bun.spawn(HUB, {
    env: { ...process.env, SESSIONBRAIN_KEY: KEY, SESSIONBRAIN_PORT: String(otherPort), SESSIONBRAIN_SESSIONS_DIR: join(dir, 'none1'), SESSIONBRAIN_PROJECTS_DIR: join(dir, 'none2'), SESSIONBRAIN_CLAUDE: '/nonexistent/claude' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    for (let i = 0; i < 100; i++) {
      if (await keyed(`http://127.0.0.1:${otherPort}/healthz`).then(r => r.ok).catch(() => false)) break
      await Bun.sleep(50)
    }
    expect(await keyed(`http://127.0.0.1:${otherPort}/api/sessions`).then(r => r.json())).toEqual([])
  } finally {
    other.kill()
  }
})

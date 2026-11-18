import { expect, test } from 'claude-code/testing'

/** The engine beneath the mod: a session, an environment, and a record of every process it runs. */
function world(on: Parameters<Parameters<typeof test>[1]>[1], answer: { exitCode: number; stdout: string; stderr: string } | Error) {
  const runs: string[][] = []
  const env: Record<string, string> = { HOME: '/home/u' }
  on('env.get', (_, e) => ({ value: env[e.name] as never }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'sessionbrain' } as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (answer instanceof Error) throw answer
    return { value: answer as never }
  })
  return { runs, env }
}

const start = { cwd: '/p', surface: 'terminal', isInteractive: true } as never

test('/sessionbrain runs the launcher for this session and says what it did', async ($, on) => {
  const w = world(on, { exitCode: 0, stdout: 'Opened in an Orca tab beside this terminal.\n', stderr: '' })
  await $.session.start(start)
  const plain = await $.command.run({ command: 'sessionbrain', args: '' } as never)
  const win = await $.command.run({ command: 'sessionbrain', args: 'window' } as never)
  const tab = await $.command.run({ command: 'sessionbrain', args: ' tab ' } as never)
  expect(w.runs).toEqual([
    ['/home/u/.local/bin/sessionbrain', 'open', '--session', 'sess-1'],
    ['/home/u/.local/bin/sessionbrain', 'open', '--session', 'sess-1', '--window'],
    ['/home/u/.local/bin/sessionbrain', 'open', '--session', 'sess-1', '--tab'],
  ])
  expect(plain.text).toBe('Opened in an Orca tab beside this terminal.')
  expect(win.text).toBe('Opened in an Orca tab beside this terminal.')
  expect(tab.text).toBe('Opened in an Orca tab beside this terminal.')
})

test('SESSIONBRAIN_BIN points /sessionbrain at another launcher', async ($, on) => {
  const w = world(on, { exitCode: 0, stdout: '', stderr: '' })
  w.env.SESSIONBRAIN_BIN = '/opt/wl/sessionbrain'
  await $.session.start(start)
  const ran = await $.command.run({ command: 'sessionbrain', args: '' } as never)
  expect(w.runs[0]?.[0]).toBe('/opt/wl/sessionbrain')
  expect(ran.text).toBe('SessionBrain opened.')
})

test('/sessionbrain says plainly when the launcher fails', async ($, on) => {
  world(on, { exitCode: 2, stdout: '', stderr: 'hub did not start\n' })
  await $.session.start(start)
  const ran = await $.command.run({ command: 'sessionbrain', args: '' } as never)
  expect(ran.text).toBe('SessionBrain could not open: hub did not start')
})

test('/sessionbrain says plainly when the launcher is not installed', async ($, on) => {
  world(on, new Error('spawn /home/u/.local/bin/sessionbrain ENOENT'))
  await $.session.start(start)
  const ran = await $.command.run({ command: 'sessionbrain', args: '' } as never)
  // However the failure reaches the mod, the person reads that it did not open, never a stack.
  expect(ran.text).toStartWith('SessionBrain could not open:')
})

test('a tool call passes through the session untouched', async ($, on) => {
  world(on, { exitCode: 0, stdout: '', stderr: '' })
  on('tool.call', () => ({ result: 'files', isError: false }) as never)
  await $.session.start(start)
  const ran = await $.tool.call({ tool: 'Bash', input: { command: 'ls' }, command: 'ls' } as never)
  expect(ran).toMatchObject({ result: 'files', isError: false })
})

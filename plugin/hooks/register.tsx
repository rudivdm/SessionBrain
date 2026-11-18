// SessionBrain: adds `/sessionbrain` to Claude Code, which opens this session's live work map beside it
// (an Orca tab when the session runs in Orca, else the SessionBrain window).
//
// The map itself needs nothing from this mod: the SessionBrain hub reads the session's transcript.
// So the mod hooks nothing but its own command, and never touches a tool call or a turn.

import type { EngineInterface, Register } from 'claude-code'

/** Runs `sessionbrain open` for this session and says what came of it. */
async function openView($: EngineInterface, args: string): Promise<string> {
  const sessionId = await $.session.id()
  const home = await $.env.get('HOME')
  const own = await $.env.get('SESSIONBRAIN_BIN')
  const bin = typeof own === 'string' && own !== '' ? own : `${home}/.local/bin/sessionbrain`
  const where = args.trim() === 'window' ? ['--window'] : args.trim() === 'tab' ? ['--tab'] : []
  const ran = await $.process.run([bin, 'open', '--session', sessionId, ...where], { timeoutMs: 20000 })
  const said = `${ran.stdout}${ran.stderr}`.trim().split('\n').pop() ?? ''
  return ran.exitCode === 0 ? said || 'SessionBrain opened.' : `SessionBrain could not open: ${said || `exit ${ran.exitCode}`}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'sessionbrain', description: 'Show the live work map of this session beside it (SessionBrain)' })
    } catch {
      // Without the command the session is exactly as it would be without SessionBrain.
    }
    return next(e)
  })

  on('command.run', { command: 'sessionbrain' }, async ($, e) => {
    try {
      return { text: await openView($, e.args ?? '') }
    } catch (failure) {
      return { text: `SessionBrain could not open: ${failure instanceof Error ? failure.message : String(failure)}` }
    }
  })
}

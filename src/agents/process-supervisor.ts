import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface SupervisorOptions {
  command: string
  args: string[]
  port: number
  hostname: string
  cwd: string
  onExit: () => Promise<void>
}

export interface FrameworkInjection {
  extraArgs: string[]
}

/**
 * Frameworks that ignore the PORT env var and need explicit CLI flags.
 * Keyed by a substring match against the full command string.
 */
const FRAMEWORK_FLAG_MAP: Array<{
  match: RegExp
  flags: (port: number) => string[]
}> = [
  { match: /\bvite\b/,          flags: (p) => ['--port', String(p), '--host', '127.0.0.1'] },
  { match: /\bastro\b/,         flags: (p) => ['--port', String(p), '--host', '0.0.0.0'] },
  { match: /\bng\s+serve\b/,    flags: (p) => ['--port', String(p)] },
  { match: /\breact-router\b/,  flags: (p) => ['--port', String(p)] },
  { match: /\bexpo\s+start\b/,  flags: (p) => ['--port', String(p)] },
  {
    match: /\breact-native\s+start\b/,
    flags: (p) => ['--port', String(p)],
  },
]

/**
 * Detect whether the given command needs explicit --port / --host flags
 * injected because the framework ignores the PORT env var.
 */
export function detectFrameworkInjection(
  command: string,
  args: string[],
  port: number
): FrameworkInjection {
  const fullCmd = [command, ...args].join(' ')

  for (const { match, flags } of FRAMEWORK_FLAG_MAP) {
    if (match.test(fullCmd)) {
      return { extraArgs: flags(port) }
    }
  }

  return { extraArgs: [] }
}

/**
 * Build the environment for the child process.
 * Always sets PORT and HOST; inherits everything else from parent.
 */
export function buildChildEnv(
  port: number,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...base,
    PORT: String(port),
    HOST: '127.0.0.1',
  }
}

/**
 * Spawn the dev server, inject port, handle cleanup on exit.
 *
 * - Sets PORT + HOST env vars
 * - Injects --port / --host flags for frameworks that ignore PORT
 * - Pipes stdout/stderr to parent (user sees dev server output normally)
 * - Calls onExit() when the child exits for any reason
 * - Forwards SIGINT/SIGTERM to child and calls onExit()
 */
export async function supervise(opts: SupervisorOptions): Promise<void> {
  const { command, args, port, hostname, cwd, onExit } = opts

  const { extraArgs } = detectFrameworkInjection(command, args, port)
  const finalArgs = [...args, ...extraArgs]
  const env = buildChildEnv(port)

  const child: ChildProcess = spawn(command, finalArgs, {
    cwd,
    env,
    stdio: 'inherit', // pipe stdout/stderr straight to terminal
    shell: false,
  })

  let cleanupCalled = false

  async function cleanup(): Promise<void> {
    if (cleanupCalled) return
    cleanupCalled = true
    try {
      await onExit()
    } catch (err) {
      // onExit errors should never crash the supervisor
      console.error('[vhost] cleanup error:', err)
    }
  }

  // Forward signals to child process
  const forwardSignal = (signal: NodeJS.Signals) => async () => {
    child.kill(signal)
    await cleanup()
    process.exit(0)
  }

  const sigintHandler = forwardSignal('SIGINT')
  const sigtermHandler = forwardSignal('SIGTERM')

  process.once('SIGINT', sigintHandler)
  process.once('SIGTERM', sigtermHandler)

  return new Promise((resolve, reject) => {
    child.once('error', async (err) => {
      process.off('SIGINT', sigintHandler)
      process.off('SIGTERM', sigtermHandler)
      await cleanup()
      reject(
        new Error(
          `Failed to start command "${command}": ${err.message}`
        )
      )
    })

    child.once('exit', async (code, signal) => {
      process.off('SIGINT', sigintHandler)
      process.off('SIGTERM', sigtermHandler)
      await cleanup()

      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
        resolve()
      } else {
        reject(
          new Error(
            `Process "${command}" exited with code ${code ?? signal}`
          )
        )
      }
    })
  })
}

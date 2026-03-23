import { exec as _exec, spawn as _spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(_exec)

export interface ExecResult {
  stdout: string
  stderr: string
}

export async function exec(cmd: string, cwd?: string): Promise<ExecResult> {
  return execAsync(cmd, { cwd })
}

export async function execSafe(cmd: string, cwd?: string): Promise<ExecResult | null> {
  try {
    return await exec(cmd, cwd)
  } catch {
    return null
  }
}

/**
 * Spawn a process without a shell — safe from command injection.
 * Use this instead of exec() when any argument comes from user input.
 */
export function spawnSafe(
  bin: string,
  args: string[],
  opts?: { cwd?: string; stdio?: 'ignore' | 'inherit' | 'pipe' }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = _spawn(bin, args, {
      cwd: opts?.cwd,
      stdio: opts?.stdio === 'ignore' ? 'ignore' : 'pipe',
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    }

    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const err = new Error(`Process exited with code ${code}: ${bin} ${args.join(' ')}`)
        ;(err as any).stdout = stdout
        ;(err as any).stderr = stderr
        reject(err)
      }
    })
  })
}

/**
 * Like spawnSafe but returns null on failure instead of throwing.
 */
export async function spawnSafeSafe(
  bin: string,
  args: string[],
  opts?: { cwd?: string }
): Promise<ExecResult | null> {
  try {
    return await spawnSafe(bin, args, opts)
  } catch {
    return null
  }
}

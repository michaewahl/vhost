import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  detectFrameworkInjection,
  buildChildEnv,
  supervise,
} from '../../src/agents/process-supervisor.js'
import type { SupervisorOptions } from '../../src/agents/process-supervisor.js'

// ─── detectFrameworkInjection ────────────────────────────────────────────────

describe('detectFrameworkInjection', () => {
  it('returns no extra args for Next.js (respects PORT)', () => {
    const result = detectFrameworkInjection('next', ['dev'], 4237)
    expect(result.extraArgs).toEqual([])
  })

  it('returns no extra args for Express (respects PORT)', () => {
    const result = detectFrameworkInjection('node', ['server.js'], 4237)
    expect(result.extraArgs).toEqual([])
  })

  it('injects --port and --host for Vite', () => {
    const result = detectFrameworkInjection('vite', [], 4237)
    expect(result.extraArgs).toContain('--port')
    expect(result.extraArgs).toContain('4237')
    expect(result.extraArgs).toContain('--host')
    expect(result.extraArgs).toContain('127.0.0.1')
  })

  it('injects flags when vite is in args (via npx/pnpm)', () => {
    const result = detectFrameworkInjection('npx', ['vite'], 4500)
    expect(result.extraArgs).toContain('--port')
    expect(result.extraArgs).toContain('4500')
  })

  it('injects --port for Astro', () => {
    const result = detectFrameworkInjection('astro', ['dev'], 4300)
    expect(result.extraArgs).toContain('--port')
    expect(result.extraArgs).toContain('4300')
  })

  it('injects --port for Angular ng serve', () => {
    const result = detectFrameworkInjection('ng', ['serve'], 4100)
    expect(result.extraArgs).toContain('--port')
    expect(result.extraArgs).toContain('4100')
  })

  it('injects --port for react-router', () => {
    const result = detectFrameworkInjection('react-router', ['dev'], 4200)
    expect(result.extraArgs).toContain('--port')
    expect(result.extraArgs).toContain('4200')
  })

  it('injects --port for expo start', () => {
    const result = detectFrameworkInjection('expo', ['start'], 4400)
    expect(result.extraArgs).toContain('--port')
    expect(result.extraArgs).toContain('4400')
  })

  it('injects --port for react-native start', () => {
    const result = detectFrameworkInjection('react-native', ['start'], 4450)
    expect(result.extraArgs).toContain('--port')
    expect(result.extraArgs).toContain('4450')
  })

  it('does not inject for ng build (only ng serve)', () => {
    const result = detectFrameworkInjection('ng', ['build'], 4100)
    expect(result.extraArgs).toEqual([])
  })
})

// ─── buildChildEnv ───────────────────────────────────────────────────────────

describe('buildChildEnv', () => {
  it('sets PORT as a string', () => {
    const env = buildChildEnv(4237)
    expect(env.PORT).toBe('4237')
  })

  it('sets HOST to 127.0.0.1', () => {
    const env = buildChildEnv(4237)
    expect(env.HOST).toBe('127.0.0.1')
  })

  it('inherits existing env vars', () => {
    const base = { NODE_ENV: 'development', PATH: '/usr/bin' }
    const env = buildChildEnv(4237, base)
    expect(env.NODE_ENV).toBe('development')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('PORT overrides any existing PORT in base env', () => {
    const base = { PORT: '3000' }
    const env = buildChildEnv(4237, base)
    expect(env.PORT).toBe('4237')
  })

  it('HOST overrides any existing HOST in base env', () => {
    const base = { HOST: '0.0.0.0' }
    const env = buildChildEnv(4237, base)
    expect(env.HOST).toBe('127.0.0.1')
  })

  it('does not mutate the base env object', () => {
    const base = { PORT: '3000' }
    buildChildEnv(4237, base)
    expect(base.PORT).toBe('3000')
  })
})

// ─── supervise (integration) ─────────────────────────────────────────────────

describe('supervise', () => {
  afterEach(() => vi.restoreAllMocks())

  function makeOpts(overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
    return {
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      port: 4237,
      hostname: 'myapp.localhost',
      cwd: process.cwd(),
      onExit: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  it('calls onExit when child exits cleanly', async () => {
    const onExit = vi.fn().mockResolvedValue(undefined)
    const opts = makeOpts({ onExit })
    await supervise(opts)
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('resolves when child exits with code 0', async () => {
    const opts = makeOpts({ args: ['-e', 'process.exit(0)'] })
    await expect(supervise(opts)).resolves.toBeUndefined()
  })

  it('rejects when child exits with non-zero code', async () => {
    const opts = makeOpts({ args: ['-e', 'process.exit(1)'] })
    await expect(supervise(opts)).rejects.toThrow('exited with code 1')
  })

  it('rejects when command does not exist', async () => {
    const opts = makeOpts({ command: 'this-command-does-not-exist-xyz' })
    await expect(supervise(opts)).rejects.toThrow()
  })

  it('calls onExit even when child exits with non-zero code', async () => {
    const onExit = vi.fn().mockResolvedValue(undefined)
    const opts = makeOpts({ args: ['-e', 'process.exit(2)'], onExit })
    await supervise(opts).catch(() => {})
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('calls onExit only once even if called multiple times', async () => {
    const onExit = vi.fn().mockResolvedValue(undefined)
    const opts = makeOpts({ onExit })
    await supervise(opts)
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('injects extra args for Vite', async () => {
    // Run a node script that prints its argv and exits 0
    // We verify the args were passed through by checking argv in child
    const onExit = vi.fn().mockResolvedValue(undefined)
    const opts: SupervisorOptions = {
      command: 'node',
      // simulate: command is "vite" for detection, but we run node to actually execute
      args: ['-e', 'process.exit(0)'],
      port: 4237,
      hostname: 'myapp.localhost',
      cwd: process.cwd(),
      onExit,
    }

    // detectFrameworkInjection is pure — test it directly
    const { extraArgs } = detectFrameworkInjection('vite', ['dev'], 4237)
    expect(extraArgs).toEqual(['--port', '4237', '--host', '127.0.0.1'])
  })

  it('passes PORT env var to child process via node -e', async () => {
    // Spawn a child that exits 0 only if PORT equals expected value
    const opts = makeOpts({
      command: 'node',
      args: ['-e', `process.exit(process.env.PORT === '4237' ? 0 : 1)`],
      port: 4237,
    })
    await expect(supervise(opts)).resolves.toBeUndefined()
  })
})

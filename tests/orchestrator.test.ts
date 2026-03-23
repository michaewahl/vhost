import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `lp-orch-test-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ─── formatUptime (via list output) ─────────────────────────────────────────
// Test the uptime formatter in isolation by importing orchestrator internals.
// Since it's not exported, we test the behaviour indirectly via list().

describe('list', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('prints "No active routes." when routes.json is empty', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      vi.doMock('../src/utils/state.js', async () => {
        const actual = await vi.importActual<typeof import('../src/utils/state.js')>('../src/utils/state.js')
        return {
          ...actual,
          readRoutes: vi.fn().mockResolvedValue({}),
        }
      })

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { list } = await import('../src/orchestrator.js')
      await list('localhost')

      const output = consoleSpy.mock.calls.map((c) => c.join('')).join('\n')
      expect(output).toContain('No active routes')
    } finally {
      await cleanup()
    }
  })

  it('prints route hostnames and ports', async () => {
    vi.doMock('../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/state.js')>('../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({
          'myapp.localhost': {
            port: 4237,
            alias: false,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            branch: 'main',
          },
        }),
      }
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { list } = await import('../src/orchestrator.js')
    await list('localhost')

    const output = consoleSpy.mock.calls.map((c) => c.join('')).join('\n')
    expect(output).toContain('myapp.localhost')
    expect(output).toContain('4237')
    expect(output).toContain('main')
  })

  it('labels aliases with ◆ and live routes with ●', async () => {
    vi.doMock('../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/state.js')>('../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({
          'my-postgres.localhost': {
            port: 5432,
            alias: true,
            createdAt: new Date().toISOString(),
          },
          'myapp.localhost': {
            port: 4237,
            alias: false,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
          },
        }),
      }
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { list } = await import('../src/orchestrator.js')
    await list('localhost')

    const output = consoleSpy.mock.calls.map((c) => c.join('')).join('\n')
    expect(output).toContain('◆')
    expect(output).toContain('●')
  })
})

// ─── get ─────────────────────────────────────────────────────────────────────

describe('get', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('prints the URL for a known service', async () => {
    vi.doMock('../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/state.js')>('../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({
          'myapp.localhost': { port: 4237, alias: false, createdAt: new Date().toISOString() },
        }),
      }
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { get } = await import('../src/orchestrator.js')
    await get('myapp', 'localhost', false)

    const output = consoleSpy.mock.calls.map((c) => c.join('')).join('\n')
    expect(output).toContain('myapp.localhost')
    expect(output).toContain('http://')
  })

  it('resolves hostname that already contains a dot', async () => {
    vi.doMock('../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/state.js')>('../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({
          'api.myapp.localhost': { port: 4300, alias: false, createdAt: new Date().toISOString() },
        }),
      }
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { get } = await import('../src/orchestrator.js')
    await get('api.myapp.localhost', 'localhost', false)

    const output = consoleSpy.mock.calls.map((c) => c.join('')).join('\n')
    expect(output).toContain('api.myapp.localhost')
  })

  it('exits with error for unknown service', async () => {
    vi.doMock('../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/state.js')>('../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({}),
      }
    })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { get } = await import('../src/orchestrator.js')
    await get('unknown', 'localhost', false)

    expect(process.exit).toHaveBeenCalledWith(1)
  })
})

// ─── run (collision detection) ───────────────────────────────────────────────

describe('run — collision detection', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('exits when route already registered and VHOST_FORCE not set', async () => {
    delete process.env.VHOST_FORCE

    vi.doMock('../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../src/utils/state.js')>('../src/utils/state.js')
      return {
        ...actual,
        ensureStateDirs: vi.fn().mockResolvedValue(undefined),
        readRoutes: vi.fn().mockResolvedValue({
          'myapp.localhost': { port: 4237, alias: false, createdAt: new Date().toISOString() },
        }),
        addRoute: vi.fn().mockResolvedValue(undefined),
        removeRoute: vi.fn().mockResolvedValue(undefined),
      }
    })

    vi.doMock('../src/agents/nginx-config-writer.js', () => ({
      ensureMainConfig: vi.fn().mockResolvedValue('/tmp/nginx.conf'),
      writeRoute: vi.fn(),
      removeRoute: vi.fn(),
      reloadNginx: vi.fn(),
    }))

    vi.doMock('../src/agents/process-supervisor.js', () => ({
      supervise: vi.fn().mockResolvedValue(undefined),
      detectFrameworkInjection: vi.fn().mockReturnValue({ extraArgs: [] }),
      buildChildEnv: vi.fn().mockReturnValue({}),
    }))

    vi.doMock('../src/agents/name-inferrer.js', () => ({
      inferName: vi.fn().mockResolvedValue('myapp'),
    }))

    vi.doMock('../src/agents/git-worktree.js', () => ({
      getWorktreeInfo: vi.fn().mockResolvedValue({ isLinkedWorktree: false, branch: null, sanitizedBranch: null }),
      buildHostname: vi.fn().mockReturnValue('myapp.localhost'),
    }))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const { run } = await import('../src/orchestrator.js')
    await expect(
      run({ command: 'next', args: ['dev'], https: false, tld: 'localhost', cwd: '/tmp' })
    ).rejects.toThrow('process.exit(1)')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

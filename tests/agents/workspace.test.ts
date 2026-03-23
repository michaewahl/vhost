import { describe, it, expect } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readWorkspaceConfig, resolveServices } from '../../src/agents/workspace.js'
import type { WorkspaceConfig } from '../../src/agents/workspace.js'

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `vhost-ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ─── readWorkspaceConfig ─────────────────────────────────────────────────

describe('readWorkspaceConfig', () => {
  it('reads a valid vhost.workspace.json', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const config: WorkspaceConfig = {
        services: {
          frontend: { path: './frontend', command: 'next dev' },
          api: { path: './api', command: 'pnpm start' },
        },
      }
      await writeFile(join(dir, 'vhost.workspace.json'), JSON.stringify(config))
      const result = await readWorkspaceConfig(dir)
      expect(result).not.toBeNull()
      expect(result!.services).toHaveProperty('frontend')
      expect(result!.services).toHaveProperty('api')
    } finally {
      await cleanup()
    }
  })

  it('returns null when file does not exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      expect(await readWorkspaceConfig(dir)).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('returns null for malformed JSON', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, 'vhost.workspace.json'), '{ broken }}}')
      expect(await readWorkspaceConfig(dir)).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('reads optional tld and https fields', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const config: WorkspaceConfig = {
        services: { app: { path: '.', command: 'npm start' } },
        tld: 'test',
        https: true,
      }
      await writeFile(join(dir, 'vhost.workspace.json'), JSON.stringify(config))
      const result = await readWorkspaceConfig(dir)
      expect(result!.tld).toBe('test')
      expect(result!.https).toBe(true)
    } finally {
      await cleanup()
    }
  })
})

// ─── resolveServices ────────────────────────────────────────────────────

describe('resolveServices', () => {
  it('resolves service paths relative to workspace dir', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const frontendDir = join(dir, 'frontend')
      await mkdir(frontendDir)

      const config: WorkspaceConfig = {
        services: {
          frontend: { path: './frontend', command: 'next dev' },
        },
      }
      const services = resolveServices(config, dir)
      expect(services).toHaveLength(1)
      expect(services[0].cwd).toBe(frontendDir)
      expect(services[0].name).toBe('frontend')
    } finally {
      await cleanup()
    }
  })

  it('splits command into command + args', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await mkdir(join(dir, 'app'))
      const config: WorkspaceConfig = {
        services: {
          app: { path: './app', command: 'pnpm run dev --turbo' },
        },
      }
      const services = resolveServices(config, dir)
      expect(services[0].command).toBe('pnpm')
      expect(services[0].args).toEqual(['run', 'dev', '--turbo'])
    } finally {
      await cleanup()
    }
  })

  it('uses service key as default name', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await mkdir(join(dir, 'api'))
      const config: WorkspaceConfig = {
        services: {
          'my-api': { path: './api', command: 'npm start' },
        },
      }
      const services = resolveServices(config, dir)
      expect(services[0].name).toBe('my-api')
    } finally {
      await cleanup()
    }
  })

  it('allows name override', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await mkdir(join(dir, 'api'))
      const config: WorkspaceConfig = {
        services: {
          backend: { path: './api', command: 'npm start', name: 'api.myapp' },
        },
      }
      const services = resolveServices(config, dir)
      expect(services[0].name).toBe('api.myapp')
    } finally {
      await cleanup()
    }
  })

  it('passes port through when specified', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await mkdir(join(dir, 'db'))
      const config: WorkspaceConfig = {
        services: {
          postgres: { path: './db', command: 'echo hi', port: 5432 },
        },
      }
      const services = resolveServices(config, dir)
      expect(services[0].port).toBe(5432)
    } finally {
      await cleanup()
    }
  })

  it('passes inject map through', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await mkdir(join(dir, 'web'))
      const config: WorkspaceConfig = {
        services: {
          web: {
            path: './web',
            command: 'next dev',
            inject: { NEXT_PUBLIC_API_URL: 'api.myapp' },
          },
        },
      }
      const services = resolveServices(config, dir)
      expect(services[0].inject).toEqual({ NEXT_PUBLIC_API_URL: 'api.myapp' })
    } finally {
      await cleanup()
    }
  })

  it('throws when service path does not exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const config: WorkspaceConfig = {
        services: {
          missing: { path: './does-not-exist', command: 'npm start' },
        },
      }
      expect(() => resolveServices(config, dir)).toThrow('does not exist')
    } finally {
      await cleanup()
    }
  })

  it('resolves multiple services', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await mkdir(join(dir, 'frontend'))
      await mkdir(join(dir, 'api'))
      await mkdir(join(dir, 'auth'))

      const config: WorkspaceConfig = {
        services: {
          frontend: { path: './frontend', command: 'next dev' },
          api: { path: './api', command: 'pnpm start' },
          auth: { path: './auth', command: 'node server.js' },
        },
      }
      const services = resolveServices(config, dir)
      expect(services).toHaveLength(3)
      expect(services.map((s) => s.name)).toEqual(['frontend', 'api', 'auth'])
    } finally {
      await cleanup()
    }
  })
})

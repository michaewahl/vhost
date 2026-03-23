import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Set isolated state dir BEFORE any dashboard module imports so readRoutes
// never reads the user's real ~/.vhost/routes.json
const TEST_STATE_DIR = join(tmpdir(), `vhost-dash-test-${Date.now()}`)
const origStateDir = process.env.VHOST_STATE_DIR
process.env.VHOST_STATE_DIR = TEST_STATE_DIR

import { DASHBOARD_HOSTNAME, DASHBOARD_PORT, isDashboardRoute } from '../../src/agents/dashboard-server.js'

// ─── isDashboardRoute + constants (static, no server needed) ─────────────────

describe('isDashboardRoute', () => {
  it('returns true for the reserved dashboard hostname', () => {
    expect(isDashboardRoute('vhost.localhost')).toBe(true)
  })

  it('returns false for user routes', () => {
    expect(isDashboardRoute('myapp.localhost')).toBe(false)
    expect(isDashboardRoute('api.myapp.localhost')).toBe(false)
    expect(isDashboardRoute('vhost')).toBe(false)
  })
})

describe('dashboard constants', () => {
  it('uses reserved port 4999', () => {
    expect(DASHBOARD_PORT).toBe(4999)
  })

  it('uses vhost.localhost hostname', () => {
    expect(DASHBOARD_HOSTNAME).toBe('vhost.localhost')
  })
})

// ─── /api/routes endpoint (needs isolated state dir) ─────────────────────────

describe('GET /api/routes', () => {
  const PORT = 4999

  beforeAll(async () => {
    await mkdir(TEST_STATE_DIR, { recursive: true })
  })

  afterAll(async () => {
    if (origStateDir !== undefined) process.env.VHOST_STATE_DIR = origStateDir
    else delete process.env.VHOST_STATE_DIR
    await rm(TEST_STATE_DIR, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Stop any running server and reset modules for fresh imports
    try {
      const mod = await import('../../src/agents/dashboard-server.js')
      await mod.stopDashboard()
    } catch {}
    vi.resetModules()
  })

  afterEach(async () => {
    try {
      const mod = await import('../../src/agents/dashboard-server.js')
      await mod.stopDashboard()
    } catch {}
    vi.restoreAllMocks()
  })

  it('returns routes from routes.json with correct shape', async () => {
    await writeFile(join(TEST_STATE_DIR, 'routes.json'), JSON.stringify({
      'myapp.localhost': {
        port: 4237,
        alias: false,
        createdAt: '2025-01-01T00:00:00Z',
        startedAt: '2025-01-01T00:00:00Z',
        branch: 'main',
      },
    }))

    vi.doMock('../../src/agents/nginx-config-writer.js', () => ({
      writeRoute: vi.fn().mockResolvedValue(undefined),
      reloadNginx: vi.fn().mockResolvedValue(undefined),
    }))

    const { startDashboard, stopDashboard } = await import('../../src/agents/dashboard-server.js')
    await startDashboard({ https: false })

    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/routes`)
      expect(res.ok).toBe(true)
      const data = await res.json() as { routes: Record<string, unknown>; proxyUptime: number | null }
      expect(data).toHaveProperty('routes')
      expect(data).toHaveProperty('proxyUptime')
      expect(data.routes).toHaveProperty('myapp.localhost')
    } finally {
      await stopDashboard()
    }
  })

  it('excludes the dashboard route from the listing', async () => {
    await writeFile(join(TEST_STATE_DIR, 'routes.json'), JSON.stringify({
      'myapp.localhost': { port: 4237, alias: false, createdAt: '2025-01-01T00:00:00Z' },
      'vhost.localhost': { port: 4999, alias: false, createdAt: '2025-01-01T00:00:00Z' },
    }))

    vi.doMock('../../src/agents/nginx-config-writer.js', () => ({
      writeRoute: vi.fn().mockResolvedValue(undefined),
      reloadNginx: vi.fn().mockResolvedValue(undefined),
    }))

    const { startDashboard, stopDashboard } = await import('../../src/agents/dashboard-server.js')
    await startDashboard({ https: false })

    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/routes`)
      const data = await res.json() as { routes: Record<string, unknown> }
      expect(data.routes).not.toHaveProperty('vhost.localhost')
      expect(data.routes).toHaveProperty('myapp.localhost')
    } finally {
      await stopDashboard()
    }
  })

  it('returns empty routes array gracefully when routes.json does not exist', async () => {
    // Delete routes.json if it exists from a prior test
    try { await rm(join(TEST_STATE_DIR, 'routes.json')) } catch {}

    vi.doMock('../../src/agents/nginx-config-writer.js', () => ({
      writeRoute: vi.fn().mockResolvedValue(undefined),
      reloadNginx: vi.fn().mockResolvedValue(undefined),
    }))

    const { startDashboard, stopDashboard } = await import('../../src/agents/dashboard-server.js')
    await startDashboard({ https: false })

    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/routes`)
      const data = await res.json() as { routes: Record<string, unknown> }
      expect(data.routes).toEqual({})
    } finally {
      await stopDashboard()
    }
  })

  it('startDashboard is idempotent — second call does not throw', async () => {
    vi.doMock('../../src/agents/nginx-config-writer.js', () => ({
      writeRoute: vi.fn().mockResolvedValue(undefined),
      reloadNginx: vi.fn().mockResolvedValue(undefined),
    }))

    const { startDashboard, stopDashboard } = await import('../../src/agents/dashboard-server.js')
    await startDashboard({ https: false })
    await expect(startDashboard({ https: false })).resolves.not.toThrow()

    await stopDashboard()
  })
})

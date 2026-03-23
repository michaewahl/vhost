import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DASHBOARD_HOSTNAME, DASHBOARD_PORT, isDashboardRoute } from '../../src/agents/dashboard-server.js'

// ─── isDashboardRoute ────────────────────────────────────────────────────────

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

// ─── Constants ───────────────────────────────────────────────────────────────

describe('dashboard constants', () => {
  it('uses reserved port 4999', () => {
    expect(DASHBOARD_PORT).toBe(4999)
  })

  it('uses vhost.localhost hostname', () => {
    expect(DASHBOARD_HOSTNAME).toBe('vhost.localhost')
  })
})

// ─── /api/routes endpoint ────────────────────────────────────────────────────

describe('GET /api/routes', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('returns routes from routes.json with correct shape', async () => {
    vi.doMock('../../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/utils/state.js')>('../../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({
          'myapp.localhost': {
            port: 4237,
            alias: false,
            createdAt: '2025-01-01T00:00:00Z',
            startedAt: '2025-01-01T00:00:00Z',
            branch: 'main',
          },
        }),
      }
    })

    vi.doMock('../../src/agents/nginx-config-writer.js', () => ({
      writeRoute: vi.fn().mockResolvedValue(undefined),
      reloadNginx: vi.fn().mockResolvedValue(undefined),
    }))

    const { startDashboard, stopDashboard } = await import('../../src/agents/dashboard-server.js')
    await startDashboard({ https: false })

    try {
      const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/routes`)
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
    vi.doMock('../../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/utils/state.js')>('../../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({
          'myapp.localhost': { port: 4237, alias: false, createdAt: '2025-01-01T00:00:00Z' },
          'vhost.localhost': { port: 4999, alias: false, createdAt: '2025-01-01T00:00:00Z' },
        }),
      }
    })

    vi.doMock('../../src/agents/nginx-config-writer.js', () => ({
      writeRoute: vi.fn().mockResolvedValue(undefined),
      reloadNginx: vi.fn().mockResolvedValue(undefined),
    }))

    const { startDashboard, stopDashboard } = await import('../../src/agents/dashboard-server.js')
    await startDashboard({ https: false })

    try {
      const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/routes`)
      const data = await res.json() as { routes: Record<string, unknown> }
      expect(data.routes).not.toHaveProperty('vhost.localhost')
      expect(data.routes).toHaveProperty('myapp.localhost')
    } finally {
      await stopDashboard()
    }
  })

  it('returns empty routes array gracefully when routes.json does not exist', async () => {
    vi.doMock('../../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/utils/state.js')>('../../src/utils/state.js')
      return {
        ...actual,
        readRoutes: vi.fn().mockResolvedValue({}),
      }
    })

    vi.doMock('../../src/agents/nginx-config-writer.js', () => ({
      writeRoute: vi.fn().mockResolvedValue(undefined),
      reloadNginx: vi.fn().mockResolvedValue(undefined),
    }))

    const { startDashboard, stopDashboard } = await import('../../src/agents/dashboard-server.js')
    await startDashboard({ https: false })

    try {
      const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/routes`)
      const data = await res.json() as { routes: Record<string, unknown> }
      expect(data.routes).toEqual({})
    } finally {
      await stopDashboard()
    }
  })

  it('startDashboard is idempotent — second call does not throw', async () => {
    vi.doMock('../../src/utils/state.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/utils/state.js')>('../../src/utils/state.js')
      return { ...actual, readRoutes: vi.fn().mockResolvedValue({}) }
    })

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

import express from 'express'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRoutes } from '../utils/state.js'
import { writeRoute, reloadNginx } from './nginx-config-writer.js'
import { logger } from '../utils/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const DASHBOARD_HOSTNAME = 'vhost.localhost'
export const DASHBOARD_PORT = 4999

let server: ReturnType<typeof express.application.listen> | null = null
let startedAt: number | null = null

/**
 * Returns true if the given hostname is the reserved dashboard route.
 * Used to exclude it from user-facing route listing.
 */
export function isDashboardRoute(hostname: string): boolean {
  return hostname === DASHBOARD_HOSTNAME
}

/**
 * Start the dashboard Express server and register its nginx route.
 * Idempotent — returns immediately if already running.
 */
export async function startDashboard(opts: {
  https: boolean
  certFile?: string
  keyFile?: string
} = { https: false }): Promise<void> {
  if (server) return

  const app = express()

  // ── API ──────────────────────────────────────────────────────────────────
  app.get('/api/routes', async (_req, res) => {
    const routes = await readRoutes()

    // Exclude the dashboard's own route from the listing
    const filtered = Object.fromEntries(
      Object.entries(routes).filter(([h]) => !isDashboardRoute(h))
    )

    res.json({
      routes: filtered,
      proxyUptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null,
    })
  })

  // ── UI ───────────────────────────────────────────────────────────────────
  app.get('/', async (_req, res) => {
    try {
      // In compiled output, index.html is copied alongside the JS
      const htmlPath = join(__dirname, '..', 'dashboard', 'index.html')
      const html = await readFile(htmlPath, 'utf-8')
      res.type('html').send(html)
    } catch {
      res.status(500).send('Dashboard UI not found. Run npm run build.')
    }
  })

  // ── Start ─────────────────────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    const s = app.listen(DASHBOARD_PORT, '127.0.0.1', () => {
      server = s
      startedAt = Date.now()
      resolve()
    })
    s.once('error', reject)
  })

  // Register nginx route for dashboard
  await writeRoute({
    hostname: DASHBOARD_HOSTNAME,
    port: DASHBOARD_PORT,
    https: opts.https,
    certFile: opts.certFile,
    keyFile: opts.keyFile,
  })

  await reloadNginx()
  logger.success(`Dashboard: http://${DASHBOARD_HOSTNAME}`)
}

/**
 * Stop the dashboard server and remove its nginx route.
 */
export async function stopDashboard(): Promise<void> {
  if (!server) return

  await new Promise<void>((resolve) => {
    server!.close(() => resolve())
    server = null
    startedAt = null
  })
}

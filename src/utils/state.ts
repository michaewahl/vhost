import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RouteEntry {
  port: number
  alias: boolean
  createdAt: string
  startedAt?: string
  branch?: string
}

export interface Routes {
  [hostname: string]: RouteEntry
}

export function getStateDir(): string {
  return process.env.VHOST_STATE_DIR ?? join(homedir(), '.vhost')
}

export function getCertsDir(): string {
  return join(getStateDir(), 'certs')
}

export function getNginxDir(): string {
  return join(getStateDir(), 'nginx')
}

export function getNginxConfdDir(): string {
  return join(getNginxDir(), 'conf.d')
}

export function getRoutesPath(): string {
  return join(getStateDir(), 'routes.json')
}

export async function ensureStateDirs(): Promise<void> {
  await mkdir(getStateDir(), { recursive: true })
  await mkdir(getCertsDir(), { recursive: true })
  await mkdir(getNginxDir(), { recursive: true })
  await mkdir(getNginxConfdDir(), { recursive: true })
}

export async function readRoutes(): Promise<Routes> {
  const path = getRoutesPath()
  if (!existsSync(path)) return {}
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as Routes
  } catch {
    return {}
  }
}

/**
 * Atomic write: write to a temp file, then rename.
 * Prevents corruption if the process is killed mid-write.
 */
export async function writeRoutes(routes: Routes): Promise<void> {
  const path = getRoutesPath()
  const tmpPath = `${path}.tmp.${process.pid}`
  await writeFile(tmpPath, JSON.stringify(routes, null, 2), 'utf-8')
  await rename(tmpPath, path)
}

/**
 * Simple file-based lock to serialize routes.json mutations.
 * Prevents concurrent read-modify-write race conditions (e.g., vhost up).
 */
const LOCK_TIMEOUT = 5000
const LOCK_RETRY_MS = 50

async function withRoutesLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${getRoutesPath()}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT

  // Acquire lock
  while (true) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx' })
      break
    } catch {
      if (Date.now() > deadline) {
        // Stale lock — force remove and retry once
        try { await unlink(lockPath) } catch {}
        try {
          await writeFile(lockPath, String(process.pid), { flag: 'wx' })
          break
        } catch {
          throw new Error('Failed to acquire routes.json lock')
        }
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }

  try {
    return await fn()
  } finally {
    try { await unlink(lockPath) } catch {}
  }
}

export async function addRoute(
  hostname: string,
  port: number,
  alias = false,
  branch?: string
): Promise<void> {
  await withRoutesLock(async () => {
    const routes = await readRoutes()
    const now = new Date().toISOString()
    routes[hostname] = {
      port,
      alias,
      createdAt: now,
      startedAt: alias ? undefined : now,
      branch,
    }
    await writeRoutes(routes)
  })
}

export async function removeRoute(hostname: string): Promise<void> {
  await withRoutesLock(async () => {
    const routes = await readRoutes()
    delete routes[hostname]
    await writeRoutes(routes)
  })
}

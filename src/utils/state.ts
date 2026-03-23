import { readFile, writeFile, mkdir } from 'node:fs/promises'
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

export async function writeRoutes(routes: Routes): Promise<void> {
  await writeFile(getRoutesPath(), JSON.stringify(routes, null, 2), 'utf-8')
}

export async function addRoute(
  hostname: string,
  port: number,
  alias = false,
  branch?: string
): Promise<void> {
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
}

export async function removeRoute(hostname: string): Promise<void> {
  const routes = await readRoutes()
  delete routes[hostname]
  await writeRoutes(routes)
}

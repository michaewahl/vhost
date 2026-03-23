import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface InjectedRoute {
  envVar: string     // e.g. "NEXT_PUBLIC_API_URL"
  hostname: string   // e.g. "api.myapp.localhost"
}

export interface VhostConfig {
  name?: string
  inject?: Record<string, string>  // envVar → serviceName
}

export interface EnvInjectorOptions {
  projectDir: string
  routes: InjectedRoute[]
  tld: string
  https: boolean
}

const BLOCK_START = '# vhost-start'
const BLOCK_END = '# vhost-end'

// ─── Pure string transforms ──────────────────────────────────────────────────

/**
 * Build the managed env block string from a list of injected routes.
 */
export function buildEnvBlock(routes: InjectedRoute[]): string {
  if (routes.length === 0) return ''
  const lines = routes.map((r) => `${r.envVar}=${r.hostname}`)
  return [BLOCK_START, ...lines, BLOCK_END].join('\n')
}

/**
 * Apply (insert or replace) the managed block in existing file content.
 * Preserves all content outside the block.
 * If block already exists: replaces it in-place.
 * If not: appends to end with a preceding newline.
 */
export function applyEnvBlock(existing: string, block: string): string {
  const hasBlock = existing.includes(BLOCK_START)

  if (hasBlock) {
    // Replace existing block in-place
    const startIdx = existing.indexOf(BLOCK_START)
    const endIdx = existing.indexOf(BLOCK_END)

    if (endIdx === -1) {
      // Malformed — block start but no end. Replace from start to end of file.
      return existing.slice(0, startIdx).trimEnd() + '\n' + block + '\n'
    }

    const before = existing.slice(0, startIdx).trimEnd()
    const after = existing.slice(endIdx + BLOCK_END.length).trimStart()

    return [before, block, after].filter(Boolean).join('\n') + '\n'
  }

  // Append to end
  const trimmed = existing.trimEnd()
  return (trimmed ? trimmed + '\n\n' : '') + block + '\n'
}

/**
 * Remove the managed block from file content entirely.
 * No-op if block is not present.
 * Preserves all content outside the block.
 */
export function removeEnvBlock(existing: string): string {
  if (!existing.includes(BLOCK_START)) return existing

  const startIdx = existing.indexOf(BLOCK_START)
  const endIdx = existing.indexOf(BLOCK_END)

  if (endIdx === -1) {
    // Malformed — remove from start marker to end of file
    return existing.slice(0, startIdx).trimEnd() + '\n'
  }

  const before = existing.slice(0, startIdx).trimEnd()
  const after = existing.slice(endIdx + BLOCK_END.length).trimStart()

  const joined = [before, after].filter(Boolean).join('\n')
  return joined ? joined + '\n' : ''
}

// ─── Config reading ───────────────────────────────────────────────────────────

/**
 * Read vhost.config.json from the project directory.
 * Returns empty object if file doesn't exist or is malformed.
 */
export async function readConfig(projectDir: string): Promise<VhostConfig> {
  const configPath = join(projectDir, 'vhost.config.json')
  if (!existsSync(configPath)) return {}

  try {
    const raw = await readFile(configPath, 'utf-8')
    return JSON.parse(raw) as VhostConfig
  } catch {
    return {}
  }
}

/**
 * Resolve the inject map from config into InjectedRoute entries.
 * Builds full URLs from service names + tld + protocol.
 */
export function resolveInjections(
  config: VhostConfig,
  tld: string,
  https: boolean
): InjectedRoute[] {
  if (!config.inject) return []

  const protocol = https ? 'https' : 'http'

  return Object.entries(config.inject).map(([envVar, serviceName]) => ({
    envVar,
    hostname: `${protocol}://${serviceName}.${tld}`,
  }))
}

// ─── Env file targeting ───────────────────────────────────────────────────────

/**
 * Resolve which env file to write to.
 * Prefers .env.local, falls back to .env, creates .env.local if neither exists.
 */
export function resolveEnvFile(projectDir: string): string {
  const envLocal = join(projectDir, '.env.local')
  const envBase = join(projectDir, '.env')

  if (existsSync(envLocal)) return envLocal
  if (existsSync(envBase)) return envBase
  return envLocal  // create .env.local
}

// ─── I/O operations ──────────────────────────────────────────────────────────

/**
 * Write injected env vars into the project's env file.
 * Creates the file if it doesn't exist.
 */
export async function injectEnvVars(opts: EnvInjectorOptions): Promise<void> {
  const { projectDir, routes, tld, https } = opts

  if (routes.length === 0) return

  const envFile = resolveEnvFile(projectDir)
  const existing = existsSync(envFile)
    ? await readFile(envFile, 'utf-8')
    : ''

  const block = buildEnvBlock(routes)
  const updated = applyEnvBlock(existing, block)

  await writeFile(envFile, updated, 'utf-8')
}

/**
 * Remove the managed block from the project's env file.
 * No-op if block is not present or file doesn't exist.
 */
export async function cleanEnvVars(projectDir: string): Promise<void> {
  const envFile = resolveEnvFile(projectDir)
  if (!existsSync(envFile)) return

  const existing = await readFile(envFile, 'utf-8')
  if (!existing.includes(BLOCK_START)) return

  const cleaned = removeEnvBlock(existing)
  await writeFile(envFile, cleaned, 'utf-8')
}

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface WorkspaceService {
  name?: string
  cwd: string
  command: string
  args: string[]
  port?: number
  inject?: Record<string, string>
}

export interface WorkspaceConfig {
  services: Record<string, {
    path: string           // relative to workspace root
    command: string        // e.g. "next dev", "pnpm start"
    name?: string          // override hostname
    port?: number          // pin a specific port
    inject?: Record<string, string>  // env injection map
  }>
  tld?: string
  https?: boolean
}

/**
 * Read vhost.workspace.json from a directory.
 * Returns null if not found.
 */
export async function readWorkspaceConfig(dir: string): Promise<WorkspaceConfig | null> {
  const configPath = join(dir, 'vhost.workspace.json')
  if (!existsSync(configPath)) return null

  try {
    const raw = await readFile(configPath, 'utf-8')
    return JSON.parse(raw) as WorkspaceConfig
  } catch {
    return null
  }
}

/**
 * Resolve workspace config into a list of services to start.
 * Validates that each service path exists.
 */
export function resolveServices(
  config: WorkspaceConfig,
  workspaceDir: string
): WorkspaceService[] {
  const services: WorkspaceService[] = []

  for (const [key, svc] of Object.entries(config.services)) {
    const cwd = resolve(workspaceDir, svc.path)

    if (!existsSync(cwd)) {
      throw new Error(`Service "${key}": path "${svc.path}" does not exist (resolved: ${cwd})`)
    }

    // Split command into command + args
    const parts = svc.command.split(/\s+/)
    const command = parts[0]
    const args = parts.slice(1)

    services.push({
      name: svc.name ?? key,
      cwd,
      command,
      args,
      port: svc.port,
      inject: svc.inject,
    })
  }

  return services
}

import { inferName, sanitizeName } from './agents/name-inferrer.js'
import { getWorktreeInfo, buildHostname } from './agents/git-worktree.js'
import { findFreePort } from './agents/port-manager.js'
import { ensureCerts, getCertPaths } from './agents/cert-manager.js'
import { writeRoute, removeRoute, reloadNginx, ensureMainConfig } from './agents/nginx-config-writer.js'
import { supervise } from './agents/process-supervisor.js'
import { readConfig, resolveInjections, injectEnvVars, cleanEnvVars } from './agents/env-injector.js'
import { readWorkspaceConfig, resolveServices } from './agents/workspace.js'
import { addRoute, removeRoute as removeStateRoute, readRoutes, ensureStateDirs } from './utils/state.js'
import { logger } from './utils/logger.js'

export interface RunOptions {
  name?: string          // explicit --name override
  command: string
  args: string[]
  https: boolean
  tld: string
  cwd: string
}

export interface AliasOptions {
  name: string
  port: number
  force?: boolean
  tld: string
  https: boolean
}

/** Strict RFC-compliant hostname regex — no shell metacharacters, no path traversal */
const VALID_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

/** Strict TLD regex — only alphanumeric and hyphens */
const VALID_TLD = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/**
 * Validate a fully-constructed hostname.
 * Throws if it contains characters that could enable config injection or path traversal.
 */
function validateHostname(hostname: string): void {
  if (!VALID_HOSTNAME.test(hostname)) {
    throw new Error(`Invalid hostname: "${hostname}". Only lowercase alphanumeric and hyphens allowed.`)
  }
  if (hostname.length > 253) {
    throw new Error(`Hostname too long: ${hostname.length} chars (max 253)`)
  }
}

/**
 * Validate a TLD value from CLI input.
 */
function validateTld(tld: string): void {
  if (!VALID_TLD.test(tld)) {
    throw new Error(`Invalid TLD: "${tld}". Only lowercase alphanumeric, hyphens, and dots allowed.`)
  }
}

/**
 * Core run sequence — wires all agents together.
 *
 * 1. Infer name
 * 2. Detect git worktree
 * 3. Build hostname
 * 4. Assign port
 * 5. Ensure certs (idempotent)
 * 6. Write nginx route + reload
 * 7. Print URL
 * 8. Supervise process (blocks until exit)
 * 9. onExit: remove route + reload
 */
export async function run(opts: RunOptions): Promise<void> {
  const { command, args, https, tld, cwd } = opts

  validateTld(tld)

  await ensureStateDirs()
  await ensureMainConfig()

  // 1. Config + Name
  const config = await readConfig(cwd)
  const baseName = opts.name ?? config.name ?? await inferName(cwd)

  // 2. Worktree
  const worktreeInfo = await getWorktreeInfo(cwd)

  // 3. Hostname
  const hostname = buildHostname(baseName, worktreeInfo, tld)
  validateHostname(hostname)

  // 4. Port — check for existing route collision
  const existingRoutes = await readRoutes()
  if (existingRoutes[hostname] && !process.env.VHOST_FORCE) {
    const existing = existingRoutes[hostname]
    logger.warn(`Route already registered: ${hostname} → port ${existing.port}`)
    logger.dim('Use VHOST_FORCE=1 to override.')
    process.exit(1)
  }

  let port: number
  if (process.env.VHOST_APP_PORT) {
    port = parseInt(process.env.VHOST_APP_PORT, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid VHOST_APP_PORT: ${process.env.VHOST_APP_PORT}`)
    }
  } else {
    port = await findFreePort([4000, 4998])  // 4999 reserved for dashboard
  }

  // 5. Certs (idempotent — skips if already done)
  let certFile: string | undefined
  let keyFile: string | undefined

  if (https) {
    try {
      const certs = await ensureCerts()
      certFile = certs.cert
      keyFile = certs.key
    } catch (err) {
      logger.warn(`HTTPS unavailable: ${(err as Error).message}`)
      logger.dim('Falling back to HTTP. Run: vhost setup')
    }
  }

  // 6. Write nginx route + reload
  await writeRoute({ hostname, port, https: https && !!certFile, certFile, keyFile })
  await addRoute(hostname, port, false, worktreeInfo.branch ?? undefined)
  await reloadNginx()

  // 7. Print URL
  const protocol = https && certFile ? 'https' : 'http'
  const portSuffix = ''
  logger.url(hostname, `${protocol}://${hostname}${portSuffix}`)

  // 8. Env injection (if vhost.config.json has inject map)
  const injections = resolveInjections(config, tld, https && !!certFile)
  if (injections.length > 0) {
    await injectEnvVars({ projectDir: cwd, routes: injections, tld, https: https && !!certFile })
    for (const r of injections) {
      logger.dim(`  ${r.envVar}=${r.hostname}`)
    }
  }

  // 9 + 10. Supervise — blocks until process exits, then cleans up
  async function onExit(): Promise<void> {
    logger.dim(`\ncleaning up ${hostname}...`)
    await removeRoute(hostname)
    await removeStateRoute(hostname)
    await reloadNginx()
    if (injections.length > 0) {
      await cleanEnvVars(cwd)
    }
  }

  await supervise({ command, args, port, hostname, cwd, onExit })
}

/**
 * Register a static alias for an external service (Docker, etc.)
 */
export async function alias(opts: AliasOptions): Promise<void> {
  const { name, port, force, tld, https } = opts

  validateTld(tld)
  const sanitized = sanitizeName(name)
  const hostname = `${sanitized}.${tld}`
  validateHostname(hostname)

  await ensureStateDirs()
  await ensureMainConfig()
  const existingRoutes = await readRoutes()

  if (existingRoutes[hostname] && !force) {
    logger.warn(`Alias already exists: ${hostname} → port ${existingRoutes[hostname].port}`)
    logger.dim('Use --force to override.')
    process.exit(1)
  }

  let certFile: string | undefined
  let keyFile: string | undefined

  if (https) {
    try {
      const certs = getCertPaths()
      certFile = certs.cert
      keyFile = certs.key
    } catch {
      // no certs — fall back to http silently for aliases
    }
  }

  await writeRoute({ hostname, port, https: https && !!certFile, certFile, keyFile })
  await addRoute(hostname, port, true)
  await reloadNginx()

  const protocol = https && certFile ? 'https' : 'http'
  const portSuffix = ''
  logger.url(`alias ${name}`, `${protocol}://${hostname}${portSuffix}`)
}

/**
 * Remove a static alias.
 */
export async function removeAlias(name: string, tld: string): Promise<void> {
  validateTld(tld)
  const sanitized = sanitizeName(name)
  const hostname = `${sanitized}.${tld}`
  validateHostname(hostname)
  const routes = await readRoutes()

  if (!routes[hostname]) {
    logger.warn(`No alias found for: ${hostname}`)
    process.exit(1)
  }

  if (!routes[hostname].alias) {
    logger.warn(`${hostname} is a live route, not an alias. Use SIGINT to stop it.`)
    process.exit(1)
  }

  await removeRoute(hostname)
  await removeStateRoute(hostname)
  await reloadNginx()

  logger.success(`Removed alias: ${hostname}`)
}

/**
 * Print all active routes.
 */
export async function list(tld: string): Promise<void> {
  const routes = await readRoutes()
  const entries = Object.entries(routes)

  if (entries.length === 0) {
    logger.dim('No active routes.')
    return
  }

  console.log('')
  for (const [hostname, info] of entries) {
    const badge = info.alias ? '◆ alias' : '● live '
    const branch = info.branch ? `  branch: ${info.branch}` : ''
    const uptime = info.startedAt
      ? `  up ${formatUptime(info.startedAt)}`
      : ''
    console.log(`  ${badge}  ${hostname} → :${info.port}${uptime}${branch}`)
  }
  console.log('')
}

/**
 * Print the URL for a named service.
 */
export async function get(name: string, tld: string, https: boolean): Promise<void> {
  validateTld(tld)
  const routes = await readRoutes()
  const hostname = name.includes('.') ? name : `${sanitizeName(name)}.${tld}`
  validateHostname(hostname)
  const route = routes[hostname]

  if (!route) {
    logger.error(`No route found for: ${hostname}`)
    process.exit(1)
  }

  const protocol = https ? 'https' : 'http'
  console.log(`${protocol}://${hostname}`)
}

/**
 * Start all services defined in vhost.workspace.json.
 * Each service runs in parallel with its own hostname.
 */
export async function up(opts: {
  cwd: string
  https: boolean
  tld: string
}): Promise<void> {
  const { cwd, https, tld } = opts

  const config = await readWorkspaceConfig(cwd)
  if (!config) {
    logger.error('No vhost.workspace.json found in current directory.')
    process.exit(1)
  }

  const services = resolveServices(config, cwd)
  if (services.length === 0) {
    logger.warn('No services defined in vhost.workspace.json.')
    return
  }

  await ensureStateDirs()
  await ensureMainConfig()

  // Ensure certs once for all services
  let certFile: string | undefined
  let keyFile: string | undefined
  const useHttps = https ?? config.https ?? false

  if (useHttps) {
    try {
      const certs = await ensureCerts()
      certFile = certs.cert
      keyFile = certs.key
    } catch (err) {
      logger.warn(`HTTPS unavailable: ${(err as Error).message}`)
    }
  }

  const useTld = tld ?? config.tld ?? 'localhost'
  validateTld(useTld)
  const protocol = useHttps && certFile ? 'https' : 'http'

  logger.info(`Starting ${services.length} services...`)
  console.log('')

  // Start all services in parallel
  const promises = services.map(async (svc) => {
    const safeName = sanitizeName(svc.name!)
    const hostname = `${safeName}.${useTld}`
    validateHostname(hostname)
    const port = svc.port
      ? svc.port
      : await findFreePort([4000, 4998])

    // Write nginx route
    await writeRoute({
      hostname,
      port,
      https: useHttps && !!certFile,
      certFile,
      keyFile,
    })
    await addRoute(hostname, port, false)
    await reloadNginx()

    // Env injection if service has inject map
    const injections = svc.inject
      ? Object.entries(svc.inject).map(([envVar, serviceName]) => ({
          envVar,
          hostname: `${protocol}://${serviceName}.${useTld}`,
        }))
      : []

    if (injections.length > 0) {
      await injectEnvVars({
        projectDir: svc.cwd,
        routes: injections,
        tld: useTld,
        https: useHttps && !!certFile,
      })
    }

    logger.url(svc.name!, `${protocol}://${hostname}`)

    // Cleanup on exit
    async function onExit(): Promise<void> {
      logger.dim(`  cleaning up ${hostname}...`)
      await removeRoute(hostname)
      await removeStateRoute(hostname)
      await reloadNginx()
      if (injections.length > 0) {
        await cleanEnvVars(svc.cwd)
      }
    }

    return supervise({
      command: svc.command,
      args: svc.args,
      port,
      hostname,
      cwd: svc.cwd,
      onExit,
    })
  })

  // Wait for all — first rejection kills the group
  await Promise.all(promises)
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h`
}

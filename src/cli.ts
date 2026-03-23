#!/usr/bin/env node
import { Command } from 'commander'
import { run, alias, removeAlias, list, get, up } from './orchestrator.js'
import { stopNginx } from './agents/nginx-config-writer.js'
import { logger } from './utils/logger.js'
import { runDoctor, printDoctorResults } from './agents/doctor.js'
import { openInBrowser } from './agents/open.js'

const DEFAULT_TLD = process.env.VHOST_TLD ?? 'localhost'
const DEFAULT_HTTPS = process.env.VHOST_HTTPS === '1'

const program = new Command()

program
  .name('vhost')
  .description('Named .localhost URLs for local development')
  .version('0.1.0')

// ─── vhost run [--name <n>] <cmd> [args...] ────────────────────────────
program
  .command('run')
  .description('Run a dev server with an inferred or named URL')
  .option('--name <n>', 'Override inferred project name')
  .option('--https', 'Enable HTTPS', DEFAULT_HTTPS)
  .option('--tld <tld>', 'Custom TLD', DEFAULT_TLD)
  .argument('<cmd>', 'Command to run')
  .argument('[args...]', 'Arguments to pass to command')
  .action(async (cmd: string, args: string[], opts: { name?: string; https: boolean; tld: string }) => {
    await run({
      name: opts.name,
      command: cmd,
      args,
      https: opts.https,
      tld: opts.tld,
      cwd: process.cwd(),
    })
  })

// ─── vhost <name> <cmd> [args...] ──────────────────────────────────────
// Explicit name shorthand: vhost myapp next dev
program
  .command('start <name> <cmd> [args...]')
  .description('Run a dev server with an explicit name')
  .option('--https', 'Enable HTTPS', DEFAULT_HTTPS)
  .option('--tld <tld>', 'Custom TLD', DEFAULT_TLD)
  .action(async (name: string, cmd: string, args: string[], opts: { https: boolean; tld: string }) => {
    await run({
      name,
      command: cmd,
      args,
      https: opts.https,
      tld: opts.tld,
      cwd: process.cwd(),
    })
  })

// ─── vhost list ─────────────────────────────────────────────────────────
program
  .command('list')
  .description('Show all active routes')
  .option('--tld <tld>', 'Custom TLD', DEFAULT_TLD)
  .action(async (opts: { tld: string }) => {
    await list(opts.tld)
  })

// ─── vhost get <name> ───────────────────────────────────────────────────
program
  .command('get <name>')
  .description('Print the URL for a service')
  .option('--tld <tld>', 'Custom TLD', DEFAULT_TLD)
  .option('--https', 'Use https in output URL', DEFAULT_HTTPS)
  .action(async (name: string, opts: { tld: string; https: boolean }) => {
    await get(name, opts.tld, opts.https)
  })

// ─── vhost alias <name> <port> ──────────────────────────────────────────
program
  .command('alias')
  .description('Register or remove a static route for an external service')
  .option('--remove <name>', 'Remove an existing alias')
  .option('--force', 'Override existing route')
  .option('--tld <tld>', 'Custom TLD', DEFAULT_TLD)
  .option('--https', 'Enable HTTPS', DEFAULT_HTTPS)
  .argument('[name]', 'Service name')
  .argument('[port]', 'Port the service is running on')
  .action(async (
    name: string | undefined,
    port: string | undefined,
    opts: { remove?: string; force?: boolean; tld: string; https: boolean }
  ) => {
    if (opts.remove) {
      await removeAlias(opts.remove, opts.tld)
      return
    }

    if (!name || !port) {
      logger.error('Usage: vhost alias <name> <port>')
      process.exit(1)
    }

    const portNum = parseInt(port, 10)
    if (isNaN(portNum)) {
      logger.error(`Invalid port: ${port}`)
      process.exit(1)
    }

    await alias({
      name,
      port: portNum,
      force: opts.force,
      tld: opts.tld,
      https: opts.https,
    })
  })

// ─── vhost proxy stop ───────────────────────────────────────────────────
const proxy = program
  .command('proxy')
  .description('Control the nginx proxy daemon')

proxy
  .command('stop')
  .description('Stop the nginx proxy daemon')
  .action(async () => {
    await stopNginx()
    logger.success('Proxy stopped.')
  })

// ─── vhost setup ────────────────────────────────────────────────────────
program
  .command('setup')
  .description('One-time setup: generate certs, trust CA, init nginx config')
  .action(async () => {
    const { ensureCerts } = await import('./agents/cert-manager.js')
    const { ensureMainConfig, startNginx, isNginxRunning } = await import('./agents/nginx-config-writer.js')
    const { ensureStateDirs } = await import('./utils/state.js')

    const { isResolverConfigured, isDnsmasqInstalled, isDnsmasqConfigured, installResolver } = await import('./agents/dns-resolver.js')

    logger.info('Setting up vhost...')

    await ensureStateDirs()
    logger.success('State directories created')

    await ensureMainConfig()
    logger.success('Nginx config initialized')

    try {
      const certs = await ensureCerts()
      logger.success(`Certs ready: ${certs.cert}`)
    } catch (err) {
      logger.warn(`Cert setup failed: ${(err as Error).message}`)
    }

    // DNS: dnsmasq + /etc/resolver for *.localhost wildcard resolution
    const tld = process.env.VHOST_TLD ?? 'localhost'
    const dnsReady = await isDnsmasqInstalled() && await isDnsmasqConfigured(tld) && await isResolverConfigured(tld)
    if (!dnsReady) {
      logger.info(`Setting up DNS for *.${tld} (requires sudo, may install dnsmasq)...`)
      try {
        await installResolver(tld)
        logger.success(`DNS configured: dnsmasq + /etc/resolver/${tld}`)
      } catch (err) {
        logger.warn(`DNS setup failed: ${(err as Error).message}`)
        logger.dim('  Run manually: brew install dnsmasq && vhost setup')
      }
    } else {
      logger.success('DNS resolver already configured')
    }

    if (!await isNginxRunning()) {
      try {
        await startNginx()
        logger.success('Nginx started')
      } catch (err) {
        logger.warn(`Nginx start failed: ${(err as Error).message}`)
        logger.dim('Make sure nginx is installed: brew install nginx')
      }
    } else {
      logger.success('Nginx already running')
    }

    logger.url('Ready', 'http://vhost.localhost')
  })

// ─── vhost doctor ────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Check system health: nginx, mkcert, certs, ports')
  .action(async () => {
    const checks = await runDoctor()
    const allOk = printDoctorResults(checks)
    if (!allOk) process.exit(1)
  })

// ─── vhost open [name] ──────────────────────────────────────────────────
program
  .command('open [name]')
  .description('Open a service URL in the browser')
  .option('--tld <tld>', 'Custom TLD', DEFAULT_TLD)
  .option('--https', 'Use https', DEFAULT_HTTPS)
  .action(async (name: string | undefined, opts: { tld: string; https: boolean }) => {
    if (!name) {
      // Open the dashboard
      await openInBrowser('http://vhost.localhost')
      logger.success('Opened vhost dashboard')
      return
    }

    const { readRoutes } = await import('./utils/state.js')
    const routes = await readRoutes()
    const hostname = name.includes('.') ? name : `${name}.${opts.tld}`
    const route = routes[hostname]

    if (!route) {
      logger.error(`No route found for: ${hostname}`)
      process.exit(1)
    }

    const protocol = opts.https ? 'https' : 'http'
    const url = `${protocol}://${hostname}`
    await openInBrowser(url)
    logger.success(`Opened ${url}`)
  })

// ─── vhost up ────────────────────────────────────────────────────────────
program
  .command('up')
  .description('Start all services from vhost.workspace.json')
  .option('--https', 'Enable HTTPS', DEFAULT_HTTPS)
  .option('--tld <tld>', 'Custom TLD', DEFAULT_TLD)
  .action(async (opts: { https: boolean; tld: string }) => {
    await up({
      cwd: process.cwd(),
      https: opts.https,
      tld: opts.tld,
    })
  })

// ─── Default: vhost <name> <cmd> [args...] ──────────────────────────────
// Handle the shorthand `vhost myapp next dev` pattern.
// Commander doesn't natively support this so we pre-process argv.
const args = process.argv.slice(2)
const knownCommands = ['run', 'start', 'list', 'get', 'alias', 'proxy', 'setup', 'doctor', 'open', 'up', '--help', '--version', '-h', '-V']

if (args.length >= 2 && !knownCommands.includes(args[0]) && !args[0].startsWith('-')) {
  // Looks like: vhost myapp next dev
  // Rewrite to:  vhost start myapp next dev
  process.argv.splice(2, 0, 'start')
}

program.parseAsync(process.argv).catch((err) => {
  logger.error((err as Error).message)
  process.exit(1)
})

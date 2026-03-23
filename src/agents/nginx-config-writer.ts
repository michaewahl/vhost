import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { exec, execSafe, spawnSafe, spawnSafeSafe } from '../utils/exec.js'
import { getNginxDir, getNginxConfdDir, getStateDir } from '../utils/state.js'

export interface NginxRoute {
  hostname: string  // e.g. "myapp.localhost"
  port: number      // e.g. 4237
  https: boolean
  certFile?: string
  keyFile?: string
}

export class NginxConfigError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'NginxConfigError'
  }
}

/**
 * Resolve the nginx binary — prefers Homebrew on macOS, falls back to PATH.
 */
export async function findNginxBin(): Promise<string> {
  // Homebrew ARM
  if (existsSync('/opt/homebrew/bin/nginx')) return '/opt/homebrew/bin/nginx'
  // Homebrew Intel
  if (existsSync('/usr/local/bin/nginx')) return '/usr/local/bin/nginx'
  // Linux / fallback
  const result = await execSafe('which nginx')
  if (result?.stdout.trim()) return result.stdout.trim()
  throw new NginxConfigError(
    'nginx not found.\n' +
    '  macOS:  brew install nginx\n' +
    '  Linux:  sudo apt install nginx  or  sudo yum install nginx'
  )
}

/**
 * Build the nginx.conf main config that includes all conf.d/*.conf files.
 * We run nginx with -c pointing to this file — system nginx is never touched.
 */
export function buildMainConfig(nginxDir: string): string {
  const confdDir = join(nginxDir, 'conf.d')
  const pidFile = join(nginxDir, 'nginx.pid')
  const logDir = join(nginxDir, 'logs')

  return `# vhost nginx config — do not edit manually
worker_processes auto;

error_log  ${join(logDir, 'error.log')} warn;
pid        ${pidFile};

events {
    worker_connections 1024;
}

http {
    access_log  ${join(logDir, 'access.log')};

    # Needed for WebSocket upgrades
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    include ${confdDir}/*.conf;
}
`
}

/**
 * Build a server block config for a single route.
 */
export function buildServerBlock(route: NginxRoute): string {
  const { hostname, port, https, certFile, keyFile } = route

  const sslLines = https && certFile && keyFile
    ? `
    ssl_certificate     ${certFile};
    ssl_certificate_key ${keyFile};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
`
    : ''

  const listenLines = https
    ? `    listen 127.0.0.1:443 ssl http2;\n    listen 127.0.0.1:80;`
    : `    listen 127.0.0.1:80;`

  return `# vhost: ${hostname} → ${port}
server {
${listenLines}
    server_name ${hostname};
${sslLines}
    location / {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
`
}

/**
 * Verify a config path resolves within the allowed directory.
 * Prevents path traversal via crafted hostnames.
 */
function assertPathContained(configPath: string, allowedDir: string): void {
  const resolved = resolve(configPath)
  const allowedBase = resolve(allowedDir)
  if (!resolved.startsWith(allowedBase + sep)) {
    throw new NginxConfigError(`Path traversal detected: ${configPath} escapes ${allowedDir}`)
  }
}

/**
 * Write a server block config file for the given route.
 */
export async function writeRoute(
  route: NginxRoute,
  confdDir?: string
): Promise<string> {
  const dir = confdDir ?? getNginxConfdDir()
  await mkdir(dir, { recursive: true })

  const configPath = join(dir, `${route.hostname}.conf`)
  assertPathContained(configPath, dir)

  await writeFile(configPath, buildServerBlock(route), 'utf-8')
  return configPath
}

/**
 * Remove the server block config file for a hostname.
 */
export async function removeRoute(
  hostname: string,
  confdDir?: string
): Promise<void> {
  const dir = confdDir ?? getNginxConfdDir()
  const configPath = join(dir, `${hostname}.conf`)
  assertPathContained(configPath, dir)

  if (existsSync(configPath)) {
    await unlink(configPath)
  }
}

/**
 * Write the main nginx.conf if it doesn't already exist.
 */
export async function ensureMainConfig(nginxDir?: string): Promise<string> {
  const dir = nginxDir ?? getNginxDir()
  const logsDir = join(dir, 'logs')
  const confdDir = join(dir, 'conf.d')
  const configPath = join(dir, 'nginx.conf')

  await mkdir(dir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await mkdir(confdDir, { recursive: true })

  if (!existsSync(configPath)) {
    await writeFile(configPath, buildMainConfig(dir), 'utf-8')
  }

  return configPath
}

/**
 * Test nginx config syntax without reloading.
 */
export async function testConfig(nginxDir?: string): Promise<boolean> {
  const dir = nginxDir ?? getNginxDir()
  const configPath = join(dir, 'nginx.conf')
  const bin = await findNginxBin()

  const result = await spawnSafeSafe(bin, ['-t', '-c', configPath])
  return result !== null && !result.stderr.includes('failed')
}

/**
 * Check if the vhost nginx instance is currently running.
 */
export async function isNginxRunning(nginxDir?: string): Promise<boolean> {
  const dir = nginxDir ?? getNginxDir()
  const pidFile = join(dir, 'nginx.pid')

  if (!existsSync(pidFile)) return false

  try {
    const pid = (await readFile(pidFile, 'utf-8')).trim()
    if (!pid) return false
    const pidNum = parseInt(pid, 10)
    // Validate PID is a positive integer in valid range
    if (isNaN(pidNum) || pidNum <= 0 || pidNum > 4194304) return false
    // Send signal 0 — checks if process exists without killing it
    process.kill(pidNum, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Start the vhost nginx instance as a daemon.
 */
export async function startNginx(nginxDir?: string): Promise<void> {
  const dir = nginxDir ?? getNginxDir()
  const configPath = await ensureMainConfig(dir)
  const bin = await findNginxBin()

  try {
    await spawnSafe(bin, ['-c', configPath])
  } catch (err) {
    throw new NginxConfigError('Failed to start nginx', err)
  }
}

/**
 * Reload nginx config gracefully (zero-downtime).
 * Starts nginx first if it isn't running.
 */
export async function reloadNginx(nginxDir?: string): Promise<void> {
  const dir = nginxDir ?? getNginxDir()

  if (!await isNginxRunning(dir)) {
    await startNginx(dir)
    return
  }

  const pidFile = join(dir, 'nginx.pid')
  const bin = await findNginxBin()
  const configPath = join(dir, 'nginx.conf')

  try {
    await spawnSafe(bin, ['-s', 'reload', '-c', configPath])
  } catch (err) {
    throw new NginxConfigError('Failed to reload nginx', err)
  }
}

/**
 * Stop the vhost nginx instance.
 */
export async function stopNginx(nginxDir?: string): Promise<void> {
  const dir = nginxDir ?? getNginxDir()

  if (!await isNginxRunning(dir)) return

  const bin = await findNginxBin()
  const configPath = join(dir, 'nginx.conf')

  try {
    await spawnSafe(bin, ['-s', 'stop', '-c', configPath])
  } catch (err) {
    throw new NginxConfigError('Failed to stop nginx', err)
  }
}

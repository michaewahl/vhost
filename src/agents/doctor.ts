import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execSafe } from '../utils/exec.js'
import { getStateDir, getCertsDir, getNginxDir, getRoutesPath, readRoutes } from '../utils/state.js'
import { findNginxBin, isNginxRunning } from './nginx-config-writer.js'
import { isMkcertInstalled, isCAInstalled } from './cert-manager.js'
import { logger } from '../utils/logger.js'

export interface CheckResult {
  label: string
  ok: boolean
  detail?: string
}

async function checkNginxInstalled(): Promise<CheckResult> {
  try {
    const bin = await findNginxBin()
    const result = await execSafe(`${bin} -v`)
    const version = result?.stderr?.trim() ?? result?.stdout?.trim() ?? 'unknown'
    return { label: 'nginx installed', ok: true, detail: version }
  } catch {
    return { label: 'nginx installed', ok: false, detail: 'brew install nginx' }
  }
}

async function checkMkcert(): Promise<CheckResult> {
  const installed = await isMkcertInstalled()
  if (!installed) {
    return { label: 'mkcert installed', ok: false, detail: 'brew install mkcert nss' }
  }
  return { label: 'mkcert installed', ok: true }
}

async function checkCA(): Promise<CheckResult> {
  const installed = await isCAInstalled()
  if (!installed) {
    return { label: 'CA trusted', ok: false, detail: 'run: mkcert -install' }
  }
  return { label: 'CA trusted', ok: true }
}

function checkStateDir(): CheckResult {
  const dir = getStateDir()
  const exists = existsSync(dir)
  return {
    label: 'state directory',
    ok: exists,
    detail: exists ? dir : `missing — run: vhost setup`,
  }
}

function checkCerts(): CheckResult {
  const dir = getCertsDir()
  const cert = join(dir, 'localhost.pem')
  const key = join(dir, 'localhost-key.pem')
  const ok = existsSync(cert) && existsSync(key)
  return {
    label: 'TLS certs',
    ok,
    detail: ok ? cert : 'missing — run: vhost setup',
  }
}

function checkNginxConfig(): CheckResult {
  const conf = join(getNginxDir(), 'nginx.conf')
  const ok = existsSync(conf)
  return {
    label: 'nginx.conf',
    ok,
    detail: ok ? conf : 'missing — run: vhost setup',
  }
}

async function checkNginxRunning(): Promise<CheckResult> {
  const running = await isNginxRunning()
  return {
    label: 'nginx running',
    ok: running,
    detail: running ? undefined : 'not running — run: vhost setup',
  }
}

async function checkPorts(): Promise<CheckResult> {
  // Check if ports 80 and 443 are available or owned by our nginx
  const result80 = await execSafe('lsof -i :80 -sTCP:LISTEN -t')
  const result443 = await execSafe('lsof -i :443 -sTCP:LISTEN -t')

  const issues: string[] = []
  if (!result80?.stdout.trim()) issues.push('port 80 not listening')
  if (!result443?.stdout.trim()) issues.push('port 443 not listening')

  if (issues.length === 0) {
    return { label: 'ports 80/443', ok: true, detail: 'listening' }
  }
  return { label: 'ports 80/443', ok: false, detail: issues.join(', ') }
}

async function checkActiveRoutes(): Promise<CheckResult> {
  const routes = await readRoutes()
  const count = Object.keys(routes).length
  return {
    label: 'active routes',
    ok: true,
    detail: `${count} registered`,
  }
}

export async function runDoctor(): Promise<CheckResult[]> {
  const checks = await Promise.all([
    checkNginxInstalled(),
    checkMkcert(),
    checkCA(),
    checkStateDir(),
    checkCerts(),
    checkNginxConfig(),
    checkNginxRunning(),
    checkPorts(),
    checkActiveRoutes(),
  ])
  return checks
}

export function printDoctorResults(checks: CheckResult[]): boolean {
  console.log('')
  let allOk = true

  for (const check of checks) {
    const icon = check.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    const detail = check.detail ? `  \x1b[2m${check.detail}\x1b[0m` : ''
    console.log(`  ${icon} ${check.label}${detail}`)
    if (!check.ok) allOk = false
  }

  console.log('')
  if (allOk) {
    logger.success('Everything looks good.')
  } else {
    logger.warn('Some checks failed. Run vhost setup to fix.')
  }

  return allOk
}

import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:os'
import { spawn } from 'node:child_process'
import { exec, execSafe } from '../utils/exec.js'

const RESOLVER_DIR = '/etc/resolver'
const DNSMASQ_CONF_DIR = '/opt/homebrew/etc/dnsmasq.d'
const DNSMASQ_CONF = '/opt/homebrew/etc/dnsmasq.conf'

/** Only lowercase alphanumeric and hyphens allowed in TLD */
const VALID_TLD = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function validateTld(tld: string): void {
  if (!VALID_TLD.test(tld) || tld.length > 63) {
    throw new Error(`Invalid TLD: "${tld}"`)
  }
}

/**
 * Check if dnsmasq is installed (Homebrew).
 */
export async function isDnsmasqInstalled(): Promise<boolean> {
  return existsSync('/opt/homebrew/bin/dnsmasq') || existsSync('/usr/local/bin/dnsmasq')
}

/**
 * Check if the macOS resolver for a TLD is configured.
 */
export async function isResolverConfigured(tld: string): Promise<boolean> {
  if (platform() !== 'darwin') return true
  validateTld(tld)

  const resolverFile = join(RESOLVER_DIR, tld)
  if (!existsSync(resolverFile)) return false

  try {
    const content = await readFile(resolverFile, 'utf-8')
    return content.includes('nameserver 127.0.0.1')
  } catch {
    return false
  }
}

/**
 * Check if dnsmasq is configured to resolve *.tld to 127.0.0.1.
 */
export async function isDnsmasqConfigured(tld: string): Promise<boolean> {
  validateTld(tld)
  const expectedLine = `address=/.${tld}/127.0.0.1`

  const confFile = join(DNSMASQ_CONF_DIR, `vhost-${tld}.conf`)
  if (existsSync(confFile)) {
    const content = await readFile(confFile, 'utf-8')
    if (content.includes(expectedLine)) return true
  }

  if (existsSync(DNSMASQ_CONF)) {
    const content = await readFile(DNSMASQ_CONF, 'utf-8')
    if (content.includes(expectedLine)) return true
  }

  return false
}

/** Run a command with sudo via spawn (no shell interpolation). */
function sudoSpawn(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`sudo ${args[0]} exited with code ${code}`))
    })
  })
}

/**
 * Full DNS setup for wildcard *.tld resolution on macOS:
 * 1. Install dnsmasq if needed (via brew)
 * 2. Configure dnsmasq to resolve *.tld → 127.0.0.1
 * 3. Create /etc/resolver/tld to route queries to dnsmasq
 * 4. Start/restart dnsmasq
 */
export async function installResolver(tld: string): Promise<void> {
  if (platform() !== 'darwin') return
  validateTld(tld)

  // 1. Check brew exists
  const brewCheck = await execSafe('which brew')
  if (!brewCheck?.stdout.trim()) {
    throw new Error('Homebrew is not installed. Install it from https://brew.sh')
  }

  // 2. Install dnsmasq if not present
  if (!await isDnsmasqInstalled()) {
    await exec('brew install dnsmasq')
  }

  // 3. Ensure dnsmasq.d include is in main conf
  if (existsSync(DNSMASQ_CONF)) {
    const mainConf = await readFile(DNSMASQ_CONF, 'utf-8')
    if (!mainConf.includes('conf-dir=/opt/homebrew/etc/dnsmasq.d')) {
      // Write to a temp file, then sudo mv to avoid shell injection
      const tmpFile = join(process.env.TMPDIR ?? '/tmp', `vhost-dnsmasq-${Date.now()}.conf`)
      await writeFile(tmpFile, mainConf.trimEnd() + '\nconf-dir=/opt/homebrew/etc/dnsmasq.d/,*.conf\n')
      await sudoSpawn(['cp', tmpFile, DNSMASQ_CONF])
    }
  }

  // 4. Write dnsmasq config for this TLD via temp file
  await sudoSpawn(['mkdir', '-p', DNSMASQ_CONF_DIR])
  const confFile = join(DNSMASQ_CONF_DIR, `vhost-${tld}.conf`)
  const tmpConf = join(process.env.TMPDIR ?? '/tmp', `vhost-dns-${tld}-${Date.now()}.conf`)
  await writeFile(tmpConf, `address=/.${tld}/127.0.0.1\n`)
  await sudoSpawn(['cp', tmpConf, confFile])

  // 5. Create /etc/resolver/tld via temp file
  await sudoSpawn(['mkdir', '-p', RESOLVER_DIR])
  const resolverFile = join(RESOLVER_DIR, tld)
  const tmpResolver = join(process.env.TMPDIR ?? '/tmp', `vhost-resolver-${tld}-${Date.now()}.conf`)
  await writeFile(tmpResolver, 'nameserver 127.0.0.1\n')
  await sudoSpawn(['cp', tmpResolver, resolverFile])

  // 6. Start or restart dnsmasq
  await sudoSpawn(['brew', 'services', 'restart', 'dnsmasq'])
}

/**
 * Verify DNS resolution works for a hostname.
 */
export async function verifyDns(hostname: string): Promise<boolean> {
  // Validate hostname to prevent injection
  if (!/^[a-z0-9.-]+$/.test(hostname)) return false
  const result = await execSafe(`dscacheutil -q host -a name ${hostname}`)
  if (!result) return false
  return result.stdout.includes('127.0.0.1')
}

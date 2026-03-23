import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:os'
import { exec, execSafe } from '../utils/exec.js'

const RESOLVER_DIR = '/etc/resolver'
const DNSMASQ_CONF_DIR = '/opt/homebrew/etc/dnsmasq.d'
const DNSMASQ_CONF = '/opt/homebrew/etc/dnsmasq.conf'

/**
 * Check if dnsmasq is installed (Homebrew).
 */
export async function isDnsmasqInstalled(): Promise<boolean> {
  return existsSync('/opt/homebrew/bin/dnsmasq') || existsSync('/usr/local/bin/dnsmasq')
}

/**
 * Check if the macOS resolver for a TLD is configured and dnsmasq is set up.
 */
export async function isResolverConfigured(tld: string): Promise<boolean> {
  if (platform() !== 'darwin') return true

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
  // Check in dnsmasq.d directory
  const confFile = join(DNSMASQ_CONF_DIR, `vhost-${tld}.conf`)
  if (existsSync(confFile)) {
    const content = await readFile(confFile, 'utf-8')
    if (content.includes(`address=/.${tld}/127.0.0.1`)) return true
  }

  // Check in main dnsmasq.conf
  if (existsSync(DNSMASQ_CONF)) {
    const content = await readFile(DNSMASQ_CONF, 'utf-8')
    if (content.includes(`address=/.${tld}/127.0.0.1`)) return true
  }

  return false
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

  // 1. Install dnsmasq if not present
  if (!await isDnsmasqInstalled()) {
    await exec('brew install dnsmasq')
  }

  // 2. Ensure dnsmasq.d include is in main conf
  if (existsSync(DNSMASQ_CONF)) {
    const mainConf = await readFile(DNSMASQ_CONF, 'utf-8')
    if (!mainConf.includes('conf-dir=/opt/homebrew/etc/dnsmasq.d')) {
      await exec(`sudo bash -c 'echo "conf-dir=/opt/homebrew/etc/dnsmasq.d/,*.conf" >> ${DNSMASQ_CONF}'`)
    }
  }

  // 3. Write dnsmasq config for this TLD
  await exec(`sudo mkdir -p ${DNSMASQ_CONF_DIR}`)
  const confFile = join(DNSMASQ_CONF_DIR, `vhost-${tld}.conf`)
  await exec(`sudo bash -c 'echo "address=/.${tld}/127.0.0.1" > ${confFile}'`)

  // 4. Create /etc/resolver/tld
  await exec(`sudo mkdir -p ${RESOLVER_DIR}`)
  await exec(`sudo bash -c 'echo "nameserver 127.0.0.1" > ${join(RESOLVER_DIR, tld)}'`)

  // 5. Start or restart dnsmasq
  await exec('sudo brew services restart dnsmasq')
}

/**
 * Verify DNS resolution works for a hostname.
 */
export async function verifyDns(hostname: string): Promise<boolean> {
  const result = await execSafe(`dscacheutil -q host -a name ${hostname}`)
  if (!result) return false
  return result.stdout.includes('127.0.0.1')
}

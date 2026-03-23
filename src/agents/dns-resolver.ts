import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:os'
import { exec, execSafe } from '../utils/exec.js'

const RESOLVER_DIR = '/etc/resolver'

/**
 * Check if the macOS resolver for a TLD is already configured.
 */
export async function isResolverConfigured(tld: string): Promise<boolean> {
  if (platform() !== 'darwin') return true // not needed on Linux

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
 * Install the macOS resolver file for wildcard *.tld resolution.
 * Requires sudo — will prompt the user.
 */
export async function installResolver(tld: string): Promise<void> {
  if (platform() !== 'darwin') return

  // Create /etc/resolver/ if needed, then write the file
  await exec(`sudo mkdir -p ${RESOLVER_DIR}`)
  await exec(`sudo bash -c 'echo "nameserver 127.0.0.1" > ${join(RESOLVER_DIR, tld)}'`)
}

/**
 * Verify DNS resolution works for a hostname.
 */
export async function verifyDns(hostname: string): Promise<boolean> {
  const result = await execSafe(`dscacheutil -q host -a name ${hostname}`)
  if (!result) return false
  return result.stdout.includes('127.0.0.1')
}

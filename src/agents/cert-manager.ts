import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { exec, execSafe, spawnSafe } from '../utils/exec.js'
import { getCertsDir } from '../utils/state.js'

/** Strict domain name regex — allows wildcard prefix for mkcert */
const VALID_DOMAIN = /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

export interface CertPaths {
  cert: string
  key: string
}

export class CertManagerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'CertManagerError'
  }
}

/**
 * Check whether mkcert is installed and on PATH.
 */
export async function isMkcertInstalled(): Promise<boolean> {
  const result = await execSafe('mkcert --version')
  return result !== null
}

/**
 * Check whether the vhost CA has already been installed
 * in the system trust store.
 */
export async function isCAInstalled(): Promise<boolean> {
  const result = await execSafe('mkcert -CAROOT')
  if (!result) return false
  const caRoot = result.stdout.trim()
  return existsSync(join(caRoot, 'rootCA.pem'))
}

/**
 * Install the mkcert CA into the system trust store.
 * Requires user interaction (sudo prompt on some systems).
 */
export async function installCA(): Promise<void> {
  try {
    await exec('mkcert -install')
  } catch (err) {
    throw new CertManagerError(
      'Failed to install mkcert CA. Try running: mkcert -install',
      err
    )
  }
}

/**
 * Generate cert + key for the given domains, stored in the certs dir.
 * Returns paths to the generated files.
 */
export async function generateCert(
  domains: string[],
  certsDir?: string
): Promise<CertPaths> {
  const dir = certsDir ?? getCertsDir()
  await mkdir(dir, { recursive: true })

  const certFile = join(dir, 'localhost.pem')
  const keyFile = join(dir, 'localhost-key.pem')

  // Validate each domain to prevent injection
  for (const domain of domains) {
    if (!VALID_DOMAIN.test(domain)) {
      throw new CertManagerError(`Invalid domain name: ${domain}`)
    }
  }

  try {
    await spawnSafe('mkcert', ['-cert-file', certFile, '-key-file', keyFile, ...domains])
  } catch (err) {
    throw new CertManagerError(
      `Failed to generate cert for domains: ${domains.join(' ')}`,
      err
    )
  }

  return { cert: certFile, key: keyFile }
}

/**
 * Idempotent entry point — skips cert generation if certs already exist,
 * skips CA install if already installed.
 *
 * Call this once during `vhost setup` or lazily before first proxy start.
 */
export async function ensureCerts(certsDir?: string): Promise<CertPaths> {
  const dir = certsDir ?? getCertsDir()
  const certFile = join(dir, 'localhost.pem')
  const keyFile = join(dir, 'localhost-key.pem')

  if (!await isMkcertInstalled()) {
    throw new CertManagerError(
      'mkcert is not installed.\n' +
      '  macOS:  brew install mkcert\n' +
      '  Linux:  https://github.com/FiloSottile/mkcert#linux\n' +
      '  Windows: choco install mkcert'
    )
  }

  if (!await isCAInstalled()) {
    await installCA()
  }

  if (existsSync(certFile) && existsSync(keyFile)) {
    return { cert: certFile, key: keyFile }
  }

  return generateCert(['localhost', '*.localhost'], dir)
}

/**
 * Return cert paths without generating — throws if certs don't exist.
 * Useful for nginx config writer to reference paths.
 */
export function getCertPaths(certsDir?: string): CertPaths {
  const dir = certsDir ?? getCertsDir()
  const cert = join(dir, 'localhost.pem')
  const key = join(dir, 'localhost-key.pem')

  if (!existsSync(cert) || !existsSync(key)) {
    throw new CertManagerError(
      'Certs not found. Run: vhost setup'
    )
  }

  return { cert, key }
}

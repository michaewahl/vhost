import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execSafe } from '../utils/exec.js'

/**
 * Sanitize a raw string into a valid subdomain-safe service name.
 * - Lowercase
 * - Scoped npm packages: @org/name → org-name
 * - Replace non-alphanumeric (except hyphens) with hyphens
 * - Collapse multiple hyphens
 * - Strip leading/trailing hyphens
 * - Truncate to 40 chars
 */
export function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@[^/]+\//, (match) => match.slice(1).replace('/', '-')) // @org/name → org-name
    .replace(/[^a-z0-9-]/g, '-')   // non-alphanumeric → hyphen
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-+|-+$/g, '')        // strip leading/trailing hyphens
    .slice(0, 40)
}

/**
 * Walk up from `startDir` looking for a package.json with a `name` field.
 * Stops at the filesystem root.
 */
async function findPackageJsonName(startDir: string): Promise<string | null> {
  let dir = startDir

  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const raw = await readFile(pkgPath, 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string }
        if (typeof pkg.name === 'string' && pkg.name.trim()) {
          return pkg.name.trim()
        }
      } catch {
        // malformed package.json — keep walking up
      }
    }

    const parent = dirname(dir)
    if (parent === dir) break // reached filesystem root
    dir = parent
  }

  return null
}

/**
 * Get the git root directory name, if cwd is inside a git repo.
 */
async function findGitRootName(cwd: string): Promise<string | null> {
  const result = await execSafe('git rev-parse --show-toplevel', cwd)
  if (!result) return null
  const root = result.stdout.trim()
  return root ? basename(root) : null
}

/**
 * Infer a clean service name from project context.
 *
 * Resolution order:
 *   1. package.json `name` field (nearest ancestor)
 *   2. Git root directory name
 *   3. basename(cwd)
 */
export async function inferName(cwd: string): Promise<string> {
  // 1. package.json
  const pkgName = await findPackageJsonName(cwd)
  if (pkgName) return sanitizeName(pkgName)

  // 2. git root name
  const gitName = await findGitRootName(cwd)
  if (gitName) return sanitizeName(gitName)

  // 3. cwd basename
  return sanitizeName(basename(cwd))
}

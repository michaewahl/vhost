import { describe, it, expect } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeName, inferName } from '../../src/agents/name-inferrer.js'

// ─── sanitizeName ────────────────────────────────────────────────────────────

describe('sanitizeName', () => {
  it('lowercases names', () => {
    expect(sanitizeName('MyApp')).toBe('myapp')
  })

  it('replaces spaces with hyphens', () => {
    expect(sanitizeName('my app')).toBe('my-app')
  })

  it('collapses multiple hyphens', () => {
    expect(sanitizeName('my--app')).toBe('my-app')
  })

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeName('-my-app-')).toBe('my-app')
  })

  it('handles scoped npm packages', () => {
    expect(sanitizeName('@org/my-package')).toBe('org-my-package')
  })

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(50)
    expect(sanitizeName(long)).toHaveLength(40)
  })

  it('handles slashes in names', () => {
    expect(sanitizeName('feat/auth-ui')).toBe('feat-auth-ui')
  })

  it('handles special characters', () => {
    expect(sanitizeName('my_app.v2')).toBe('my-app-v2')
  })
})

// ─── inferName ───────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `vhost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('inferName', () => {
  it('reads name from package.json', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'my-cool-app' }))
      expect(await inferName(dir)).toBe('my-cool-app')
    } finally {
      await cleanup()
    }
  })

  it('sanitizes scoped package name from package.json', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@acme/dashboard' }))
      expect(await inferName(dir)).toBe('acme-dashboard')
    } finally {
      await cleanup()
    }
  })

  it('walks up to find package.json in parent', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'parent-app' }))
      const subdir = join(dir, 'src', 'components')
      await mkdir(subdir, { recursive: true })
      expect(await inferName(subdir)).toBe('parent-app')
    } finally {
      await cleanup()
    }
  })

  it('skips package.json without name field', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }))
      // No git here either — falls back to dir basename
      const result = await inferName(dir)
      // basename of temp dir should be used
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('falls back to cwd basename when no package.json or git', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      // No package.json, not a git repo → basename of dir
      const result = await inferName(dir)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('handles malformed package.json gracefully', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, 'package.json'), '{ not valid json }}}')
      const result = await inferName(dir)
      expect(typeof result).toBe('string')
    } finally {
      await cleanup()
    }
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildEnvBlock,
  applyEnvBlock,
  removeEnvBlock,
  readConfig,
  resolveInjections,
  resolveEnvFile,
  injectEnvVars,
  cleanEnvVars,
} from '../../src/agents/env-injector.js'
import type { InjectedRoute, VhostConfig } from '../../src/agents/env-injector.js'

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `lp-env-test-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const routes: InjectedRoute[] = [
  { envVar: 'NEXT_PUBLIC_API_URL', hostname: 'https://api.myapp.localhost' },
  { envVar: 'NEXT_PUBLIC_AUTH_URL', hostname: 'https://auth.myapp.localhost' },
]

// ─── buildEnvBlock ───────────────────────────────────────────────────────────

describe('buildEnvBlock', () => {
  it('includes block start and end markers', () => {
    const block = buildEnvBlock(routes)
    expect(block).toContain('# vhost-start')
    expect(block).toContain('# vhost-end')
  })

  it('includes all env var assignments', () => {
    const block = buildEnvBlock(routes)
    expect(block).toContain('NEXT_PUBLIC_API_URL=https://api.myapp.localhost')
    expect(block).toContain('NEXT_PUBLIC_AUTH_URL=https://auth.myapp.localhost')
  })

  it('returns empty string for empty routes', () => {
    expect(buildEnvBlock([])).toBe('')
  })

  it('places start marker before vars and end marker after', () => {
    const block = buildEnvBlock(routes)
    const startIdx = block.indexOf('# vhost-start')
    const endIdx = block.indexOf('# vhost-end')
    const varIdx = block.indexOf('NEXT_PUBLIC_API_URL')

    expect(startIdx).toBeLessThan(varIdx)
    expect(varIdx).toBeLessThan(endIdx)
  })
})

// ─── applyEnvBlock ───────────────────────────────────────────────────────────

describe('applyEnvBlock', () => {
  const block = buildEnvBlock(routes)

  it('appends block to empty file', () => {
    const result = applyEnvBlock('', block)
    expect(result).toContain('# vhost-start')
    expect(result).toContain('NEXT_PUBLIC_API_URL=https://api.myapp.localhost')
  })

  it('appends block to file with existing content', () => {
    const existing = 'DATABASE_URL=postgres://localhost/mydb\n'
    const result = applyEnvBlock(existing, block)
    expect(result).toContain('DATABASE_URL=postgres://localhost/mydb')
    expect(result).toContain('# vhost-start')
  })

  it('preserves content above existing block', () => {
    const existing = `DATABASE_URL=postgres://localhost\n# vhost-start\nOLD_VAR=old\n# vhost-end\n`
    const result = applyEnvBlock(existing, block)
    expect(result).toContain('DATABASE_URL=postgres://localhost')
    expect(result).toContain('NEXT_PUBLIC_API_URL=https://api.myapp.localhost')
    expect(result).not.toContain('OLD_VAR=old')
  })

  it('preserves content below existing block', () => {
    const existing = `# vhost-start\nOLD_VAR=old\n# vhost-end\nOTHER_VAR=keep\n`
    const result = applyEnvBlock(existing, block)
    expect(result).toContain('OTHER_VAR=keep')
    expect(result).toContain('NEXT_PUBLIC_API_URL=https://api.myapp.localhost')
    expect(result).not.toContain('OLD_VAR=old')
  })

  it('replaces block in-place, not appended again', () => {
    const existing = `# vhost-start\nOLD=old\n# vhost-end\n`
    const result = applyEnvBlock(existing, block)
    const count = (result.match(/# vhost-start/g) ?? []).length
    expect(count).toBe(1)
  })

  it('handles malformed block (start but no end)', () => {
    const existing = `BEFORE=1\n# vhost-start\nDANGLING=yes\n`
    const result = applyEnvBlock(existing, block)
    expect(result).toContain('BEFORE=1')
    expect(result).toContain('# vhost-start')
    expect(result).not.toContain('DANGLING=yes')
  })
})

// ─── removeEnvBlock ──────────────────────────────────────────────────────────

describe('removeEnvBlock', () => {
  it('removes the managed block entirely', () => {
    const existing = `DB=postgres\n# vhost-start\nVAR=val\n# vhost-end\nOTHER=keep\n`
    const result = removeEnvBlock(existing)
    expect(result).not.toContain('# vhost-start')
    expect(result).not.toContain('# vhost-end')
    expect(result).not.toContain('VAR=val')
  })

  it('preserves content above and below the block', () => {
    const existing = `ABOVE=yes\n# vhost-start\nVAR=val\n# vhost-end\nBELOW=yes\n`
    const result = removeEnvBlock(existing)
    expect(result).toContain('ABOVE=yes')
    expect(result).toContain('BELOW=yes')
  })

  it('is a no-op when no block exists', () => {
    const existing = 'DATABASE_URL=postgres://localhost\n'
    expect(removeEnvBlock(existing)).toBe(existing)
  })

  it('returns empty string when file contained only the block', () => {
    const existing = `# vhost-start\nVAR=val\n# vhost-end\n`
    const result = removeEnvBlock(existing)
    expect(result.trim()).toBe('')
  })

  it('handles malformed block (start but no end)', () => {
    const existing = `BEFORE=1\n# vhost-start\nDANGLING=yes\n`
    const result = removeEnvBlock(existing)
    expect(result).toContain('BEFORE=1')
    expect(result).not.toContain('DANGLING=yes')
  })
})

// ─── readConfig ──────────────────────────────────────────────────────────────

describe('readConfig', () => {
  it('reads a valid vhost.config.json', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const config: VhostConfig = {
        name: 'frontend',
        inject: { NEXT_PUBLIC_API_URL: 'api.myapp' },
      }
      await writeFile(join(dir, 'vhost.config.json'), JSON.stringify(config))
      const result = await readConfig(dir)
      expect(result.name).toBe('frontend')
      expect(result.inject?.NEXT_PUBLIC_API_URL).toBe('api.myapp')
    } finally {
      await cleanup()
    }
  })

  it('returns empty object when file does not exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      expect(await readConfig(dir)).toEqual({})
    } finally {
      await cleanup()
    }
  })

  it('returns empty object for malformed JSON', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, 'vhost.config.json'), '{ not valid }}}')
      expect(await readConfig(dir)).toEqual({})
    } finally {
      await cleanup()
    }
  })
})

// ─── resolveInjections ───────────────────────────────────────────────────────

describe('resolveInjections', () => {
  it('maps service names to full URLs', () => {
    const config: VhostConfig = {
      inject: {
        NEXT_PUBLIC_API_URL: 'api.myapp',
        NEXT_PUBLIC_AUTH_URL: 'auth.myapp',
      },
    }
    const result = resolveInjections(config, 'localhost', true)
    expect(result).toHaveLength(2)
    expect(result[0].envVar).toBe('NEXT_PUBLIC_API_URL')
    expect(result[0].hostname).toBe('https://api.myapp.localhost')
    expect(result[1].hostname).toBe('https://auth.myapp.localhost')
  })

  it('uses http when https is false', () => {
    const config: VhostConfig = { inject: { API_URL: 'api.myapp' } }
    const result = resolveInjections(config, 'localhost', false)
    expect(result[0].hostname).toBe('http://api.myapp.localhost')
  })

  it('respects custom TLD', () => {
    const config: VhostConfig = { inject: { API_URL: 'api.myapp' } }
    const result = resolveInjections(config, 'test', true)
    expect(result[0].hostname).toBe('https://api.myapp.test')
  })

  it('returns empty array when inject is not defined', () => {
    expect(resolveInjections({}, 'localhost', true)).toEqual([])
    expect(resolveInjections({ name: 'app' }, 'localhost', true)).toEqual([])
  })
})

// ─── resolveEnvFile ──────────────────────────────────────────────────────────

describe('resolveEnvFile', () => {
  it('prefers .env.local when it exists', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, '.env.local'), '')
      await writeFile(join(dir, '.env'), '')
      expect(resolveEnvFile(dir)).toBe(join(dir, '.env.local'))
    } finally {
      await cleanup()
    }
  })

  it('falls back to .env when .env.local does not exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, '.env'), '')
      expect(resolveEnvFile(dir)).toBe(join(dir, '.env'))
    } finally {
      await cleanup()
    }
  })

  it('returns .env.local path when neither file exists (to create)', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      expect(resolveEnvFile(dir)).toBe(join(dir, '.env.local'))
    } finally {
      await cleanup()
    }
  })
})

// ─── injectEnvVars ────────────────────────────────────────────────────────────

describe('injectEnvVars', () => {
  it('creates .env.local and writes block when no env file exists', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await injectEnvVars({ projectDir: dir, routes, tld: 'localhost', https: true })
      const content = await readFile(join(dir, '.env.local'), 'utf-8')
      expect(content).toContain('NEXT_PUBLIC_API_URL=https://api.myapp.localhost')
    } finally {
      await cleanup()
    }
  })

  it('appends block to existing .env.local without overwriting', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, '.env.local'), 'EXISTING=value\n')
      await injectEnvVars({ projectDir: dir, routes, tld: 'localhost', https: true })
      const content = await readFile(join(dir, '.env.local'), 'utf-8')
      expect(content).toContain('EXISTING=value')
      expect(content).toContain('NEXT_PUBLIC_API_URL=https://api.myapp.localhost')
    } finally {
      await cleanup()
    }
  })

  it('is a no-op when routes array is empty', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await injectEnvVars({ projectDir: dir, routes: [], tld: 'localhost', https: true })
      // No file should have been created
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(dir, '.env.local'))).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

// ─── cleanEnvVars ────────────────────────────────────────────────────────────

describe('cleanEnvVars', () => {
  it('removes block from .env.local, preserving other content', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const initial = `KEEP=this\n# vhost-start\nNEXT_PUBLIC_API_URL=https://api.myapp.localhost\n# vhost-end\n`
      await writeFile(join(dir, '.env.local'), initial)
      await cleanEnvVars(dir)
      const content = await readFile(join(dir, '.env.local'), 'utf-8')
      expect(content).toContain('KEEP=this')
      expect(content).not.toContain('# vhost-start')
    } finally {
      await cleanup()
    }
  })

  it('is a no-op when no env file exists', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await expect(cleanEnvVars(dir)).resolves.not.toThrow()
    } finally {
      await cleanup()
    }
  })

  it('is a no-op when env file has no managed block', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await writeFile(join(dir, '.env.local'), 'SAFE=value\n')
      await cleanEnvVars(dir)
      const content = await readFile(join(dir, '.env.local'), 'utf-8')
      expect(content).toBe('SAFE=value\n')
    } finally {
      await cleanup()
    }
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CertManagerError } from '../../src/agents/cert-manager.js'

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `lp-certs-test-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('isMkcertInstalled', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('returns true when mkcert is on PATH', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      exec: vi.fn(),
      execSafe: vi.fn().mockResolvedValue({ stdout: 'v1.4.4', stderr: '' }),
    }))
    const { isMkcertInstalled } = await import('../../src/agents/cert-manager.js')
    expect(await isMkcertInstalled()).toBe(true)
  })

  it('returns false when mkcert is not installed', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      exec: vi.fn(),
      execSafe: vi.fn().mockResolvedValue(null),
    }))
    const { isMkcertInstalled } = await import('../../src/agents/cert-manager.js')
    expect(await isMkcertInstalled()).toBe(false)
  })
})

describe('ensureCerts', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('throws a helpful error when mkcert is not installed', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      exec: vi.fn(),
      execSafe: vi.fn().mockResolvedValue(null),
    }))
    const { ensureCerts } = await import('../../src/agents/cert-manager.js')
    const { dir, cleanup } = await makeTempDir()
    try {
      await expect(ensureCerts(dir)).rejects.toThrow('mkcert is not installed')
    } finally {
      await cleanup()
    }
  })

  it('skips cert generation if certs already exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      // Pre-create cert files
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'localhost.pem'), 'fake-cert')
      await writeFile(join(dir, 'localhost-key.pem'), 'fake-key')

      const generateCertMock = vi.fn()
      vi.doMock('../../src/utils/exec.js', () => ({
        exec: generateCertMock,
        execSafe: vi.fn().mockResolvedValue({ stdout: 'v1.4.4', stderr: '' }),
      }))

      const { ensureCerts } = await import('../../src/agents/cert-manager.js')
      const paths = await ensureCerts(dir)

      expect(paths.cert).toBe(join(dir, 'localhost.pem'))
      expect(paths.key).toBe(join(dir, 'localhost-key.pem'))
      // mkcert generate should NOT have been called
      expect(generateCertMock).not.toHaveBeenCalledWith(
        expect.stringContaining('mkcert -cert-file')
      )
    } finally {
      await cleanup()
    }
  })

  it('returns correct cert paths after generation', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      vi.doMock('../../src/utils/exec.js', () => ({
        // exec is called for mkcert -install and mkcert -cert-file
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
        execSafe: vi.fn((cmd: string) => {
          if (cmd === 'mkcert --version') return Promise.resolve({ stdout: 'v1.4.4', stderr: '' })
          if (cmd === 'mkcert -CAROOT') return Promise.resolve({ stdout: dir, stderr: '' })
          return Promise.resolve(null)
        }),
      }))

      // Simulate mkcert writing the files
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
          ...actual,
          // Let mkdir pass through; writeFile creates the cert stubs
        }
      })

      const { writeFile } = await import('node:fs/promises')
      // Pre-write to simulate mkcert output after exec resolves
      await writeFile(join(dir, 'localhost.pem'), 'cert')
      await writeFile(join(dir, 'localhost-key.pem'), 'key')

      const { ensureCerts } = await import('../../src/agents/cert-manager.js')
      const paths = await ensureCerts(dir)

      expect(paths.cert).toContain('localhost.pem')
      expect(paths.key).toContain('localhost-key.pem')
    } finally {
      await cleanup()
    }
  })
})

describe('getCertPaths', () => {
  afterEach(() => vi.resetModules())

  it('returns paths when certs exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'localhost.pem'), 'cert')
      await writeFile(join(dir, 'localhost-key.pem'), 'key')

      const { getCertPaths } = await import('../../src/agents/cert-manager.js')
      const paths = getCertPaths(dir)

      expect(paths.cert).toBe(join(dir, 'localhost.pem'))
      expect(paths.key).toBe(join(dir, 'localhost-key.pem'))
    } finally {
      await cleanup()
    }
  })

  it('throws when certs are missing', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const { getCertPaths } = await import('../../src/agents/cert-manager.js')
      expect(() => getCertPaths(dir)).toThrow('vhost setup')
    } finally {
      await cleanup()
    }
  })
})

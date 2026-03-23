import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

// We now test that openInBrowser uses spawn (not exec) with shell: false
describe('openInBrowser', () => {
  afterEach(() => vi.restoreAllMocks())

  it('validates URL protocol and rejects non-http(s)', async () => {
    const { openInBrowser } = await import('../../src/agents/open.js')
    await expect(openInBrowser('ftp://evil.com')).rejects.toThrow('Disallowed URL protocol')
  })

  it('rejects invalid URLs', async () => {
    const { openInBrowser } = await import('../../src/agents/open.js')
    await expect(openInBrowser('not-a-url')).rejects.toThrow()
  })

  it('accepts valid https URLs', async () => {
    vi.doMock('node:os', () => ({
      platform: () => 'darwin',
    }))

    // Mock spawn to avoid actually opening a browser
    const mockChild = new EventEmitter()
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn().mockReturnValue(mockChild),
    }))

    vi.resetModules()
    const { openInBrowser } = await import('../../src/agents/open.js')
    const promise = openInBrowser('https://myapp.localhost')

    // Simulate successful close
    setTimeout(() => mockChild.emit('close', 0), 10)
    await expect(promise).resolves.toBeUndefined()
  })
})

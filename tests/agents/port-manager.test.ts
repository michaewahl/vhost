import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { findFreePort, isPortAvailable } from '../../src/agents/port-manager.js'

function occupyPort(port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve(() => server.close())
    })
  })
}

describe('isPortAvailable', () => {
  it('returns true for an unoccupied port', async () => {
    const port = 4500
    expect(await isPortAvailable(port)).toBe(true)
  })

  it('returns false for an occupied port', async () => {
    const release = await occupyPort(4501)
    try {
      expect(await isPortAvailable(4501)).toBe(false)
    } finally {
      release()
    }
  })
})

describe('findFreePort', () => {
  it('returns a port within the default range', async () => {
    const port = await findFreePort()
    expect(port).toBeGreaterThanOrEqual(4000)
    expect(port).toBeLessThanOrEqual(4999)
  })

  it('returns a port within a custom range', async () => {
    const port = await findFreePort([5100, 5200])
    expect(port).toBeGreaterThanOrEqual(5100)
    expect(port).toBeLessThanOrEqual(5200)
  })

  it('returns an actually available port', async () => {
    const port = await findFreePort()
    expect(await isPortAvailable(port)).toBe(true)
  })

  it('skips an occupied port', async () => {
    // Occupy 4600–4609, find in that narrow range → should still find 4610+
    const releases: (() => void)[] = []
    for (let p = 4600; p <= 4609; p++) {
      releases.push(await occupyPort(p))
    }
    try {
      const port = await findFreePort([4600, 4999])
      expect(port).toBeGreaterThanOrEqual(4610)
    } finally {
      releases.forEach((r) => r())
    }
  })

  it('throws on invalid range', async () => {
    await expect(findFreePort([5000, 4000])).rejects.toThrow('Invalid port range')
  })
})

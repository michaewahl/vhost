import { describe, it, expect, vi, afterEach } from 'vitest'
import { isResolverConfigured } from '../../src/agents/dns-resolver.js'

describe('isResolverConfigured', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a boolean', async () => {
    const result = await isResolverConfigured('localhost')
    expect(typeof result).toBe('boolean')
  })

  it('checks the correct file path for the given TLD', async () => {
    // On a machine without /etc/resolver/nonexistent-tld, should return false
    const result = await isResolverConfigured('nonexistent-tld-12345')
    expect(result).toBe(false)
  })
})

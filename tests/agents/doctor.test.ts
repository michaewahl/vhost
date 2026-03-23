import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runDoctor, printDoctorResults } from '../../src/agents/doctor.js'
import type { CheckResult } from '../../src/agents/doctor.js'

describe('runDoctor', () => {
  it('returns an array of check results', async () => {
    const results = await runDoctor()
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  it('each result has label and ok properties', async () => {
    const results = await runDoctor()
    for (const r of results) {
      expect(r).toHaveProperty('label')
      expect(r).toHaveProperty('ok')
      expect(typeof r.label).toBe('string')
      expect(typeof r.ok).toBe('boolean')
    }
  })

  it('includes checks for nginx, mkcert, certs, and state dir', async () => {
    const results = await runDoctor()
    const labels = results.map((r) => r.label)
    expect(labels).toContain('nginx installed')
    expect(labels).toContain('mkcert installed')
    expect(labels).toContain('state directory')
    expect(labels).toContain('TLS certs')
    expect(labels).toContain('nginx.conf')
    expect(labels).toContain('active routes')
    expect(labels.some((l) => l.startsWith('DNS resolver'))).toBe(true)
  })

  it('active routes check is always ok (informational)', async () => {
    const results = await runDoctor()
    const routesCheck = results.find((r) => r.label === 'active routes')
    expect(routesCheck?.ok).toBe(true)
  })
})

describe('printDoctorResults', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns true when all checks pass', () => {
    const checks: CheckResult[] = [
      { label: 'test1', ok: true },
      { label: 'test2', ok: true },
    ]
    expect(printDoctorResults(checks)).toBe(true)
  })

  it('returns false when any check fails', () => {
    const checks: CheckResult[] = [
      { label: 'test1', ok: true },
      { label: 'test2', ok: false, detail: 'broken' },
    ]
    expect(printDoctorResults(checks)).toBe(false)
  })

  it('prints check labels to console', () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const checks: CheckResult[] = [
      { label: 'nginx installed', ok: true, detail: 'v1.25' },
    ]
    printDoctorResults(checks)
    const output = consoleSpy.mock.calls.map((c) => c.join('')).join('\n')
    expect(output).toContain('nginx installed')
    expect(output).toContain('v1.25')
  })
})

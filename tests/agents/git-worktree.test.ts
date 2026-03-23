import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseWorktreeList, buildHostname } from '../../src/agents/git-worktree.js'
import type { WorktreeInfo } from '../../src/agents/git-worktree.js'

// ─── parseWorktreeList ───────────────────────────────────────────────────────

describe('parseWorktreeList', () => {
  it('parses a single main worktree', () => {
    const output = `
worktree /home/user/myapp
HEAD abc1234
branch refs/heads/main
`.trim()

    const entries = parseWorktreeList(output)
    expect(entries).toHaveLength(1)
    expect(entries[0].worktree).toBe('/home/user/myapp')
    expect(entries[0].branch).toBe('main')
    expect(entries[0].isMain).toBe(true)
  })

  it('parses main + linked worktree', () => {
    const output = `
worktree /home/user/myapp
HEAD abc1234
branch refs/heads/main

worktree /home/user/myapp-fix-ui
HEAD def5678
branch refs/heads/fix-ui
`.trim()

    const entries = parseWorktreeList(output)
    expect(entries).toHaveLength(2)
    expect(entries[0].isMain).toBe(true)
    expect(entries[1].isMain).toBe(false)
    expect(entries[1].branch).toBe('fix-ui')
    expect(entries[1].worktree).toBe('/home/user/myapp-fix-ui')
  })

  it('parses branch with slashes', () => {
    const output = `
worktree /home/user/myapp
HEAD abc1234
branch refs/heads/main

worktree /home/user/myapp-feat-auth
HEAD 111aaaa
branch refs/heads/feat/auth
`.trim()

    const entries = parseWorktreeList(output)
    expect(entries[1].branch).toBe('feat/auth')
  })

  it('handles detached HEAD (no branch line)', () => {
    const output = `
worktree /home/user/myapp
HEAD abc1234
branch refs/heads/main

worktree /home/user/myapp-detached
HEAD deadbeef
`.trim()

    const entries = parseWorktreeList(output)
    expect(entries[1].branch).toBeNull()
  })

  it('handles multiple linked worktrees', () => {
    const output = `
worktree /home/user/myapp
HEAD aaa
branch refs/heads/main

worktree /home/user/myapp-feat-a
HEAD bbb
branch refs/heads/feat/a

worktree /home/user/myapp-feat-b
HEAD ccc
branch refs/heads/feat/b
`.trim()

    const entries = parseWorktreeList(output)
    expect(entries).toHaveLength(3)
    expect(entries[0].isMain).toBe(true)
    expect(entries[1].isMain).toBe(false)
    expect(entries[2].isMain).toBe(false)
  })

  it('returns empty array for empty input', () => {
    expect(parseWorktreeList('')).toHaveLength(0)
    expect(parseWorktreeList('   ')).toHaveLength(0)
  })
})

// ─── getWorktreeInfo (mocked exec) ──────────────────────────────────────────

describe('getWorktreeInfo', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns isLinkedWorktree false for main worktree', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      execSafe: vi.fn().mockResolvedValue({
        stdout: [
          'worktree /home/user/myapp',
          'HEAD abc1234',
          'branch refs/heads/main',
        ].join('\n'),
        stderr: '',
      }),
    }))

    const { getWorktreeInfo } = await import('../../src/agents/git-worktree.js')
    const info = await getWorktreeInfo('/home/user/myapp')

    expect(info.isLinkedWorktree).toBe(false)
    expect(info.branch).toBeNull()
    expect(info.sanitizedBranch).toBeNull()
  })

  it('returns isLinkedWorktree true for linked worktree', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      execSafe: vi.fn().mockResolvedValue({
        stdout: [
          'worktree /home/user/myapp',
          'HEAD abc1234',
          'branch refs/heads/main',
          '',
          'worktree /home/user/myapp-fix-ui',
          'HEAD def5678',
          'branch refs/heads/fix-ui',
        ].join('\n'),
        stderr: '',
      }),
    }))

    const { getWorktreeInfo } = await import('../../src/agents/git-worktree.js')
    const info = await getWorktreeInfo('/home/user/myapp-fix-ui')

    expect(info.isLinkedWorktree).toBe(true)
    expect(info.branch).toBe('fix-ui')
    expect(info.sanitizedBranch).toBe('fix-ui')
  })

  it('sanitizes branch with slashes', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      execSafe: vi.fn().mockResolvedValue({
        stdout: [
          'worktree /home/user/myapp',
          'HEAD abc1234',
          'branch refs/heads/main',
          '',
          'worktree /home/user/myapp-feat-auth',
          'HEAD 111aaaa',
          'branch refs/heads/feat/auth',
        ].join('\n'),
        stderr: '',
      }),
    }))

    const { getWorktreeInfo } = await import('../../src/agents/git-worktree.js')
    const info = await getWorktreeInfo('/home/user/myapp-feat-auth')

    expect(info.isLinkedWorktree).toBe(true)
    expect(info.branch).toBe('feat/auth')
    expect(info.sanitizedBranch).toBe('feat-auth')
  })

  it('returns false when not in a git repo', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      execSafe: vi.fn().mockResolvedValue(null),
    }))

    const { getWorktreeInfo } = await import('../../src/agents/git-worktree.js')
    const info = await getWorktreeInfo('/tmp/not-a-repo')

    expect(info.isLinkedWorktree).toBe(false)
  })

  it('returns false when cwd not found in worktree list', async () => {
    vi.doMock('../../src/utils/exec.js', () => ({
      execSafe: vi.fn().mockResolvedValue({
        stdout: [
          'worktree /home/user/myapp',
          'HEAD abc1234',
          'branch refs/heads/main',
        ].join('\n'),
        stderr: '',
      }),
    }))

    const { getWorktreeInfo } = await import('../../src/agents/git-worktree.js')
    const info = await getWorktreeInfo('/some/other/path')

    expect(info.isLinkedWorktree).toBe(false)
  })
})

// ─── buildHostname ───────────────────────────────────────────────────────────

describe('buildHostname', () => {
  const noWorktree: WorktreeInfo = {
    isLinkedWorktree: false,
    branch: null,
    sanitizedBranch: null,
  }

  const withWorktree: WorktreeInfo = {
    isLinkedWorktree: true,
    branch: 'fix-ui',
    sanitizedBranch: 'fix-ui',
  }

  const slashBranch: WorktreeInfo = {
    isLinkedWorktree: true,
    branch: 'feat/auth',
    sanitizedBranch: 'feat-auth',
  }

  it('builds plain hostname for main worktree', () => {
    expect(buildHostname('myapp', noWorktree)).toBe('myapp.localhost')
  })

  it('prepends branch as subdomain for linked worktree', () => {
    expect(buildHostname('myapp', withWorktree)).toBe('fix-ui.myapp.localhost')
  })

  it('uses sanitized branch with slashes', () => {
    expect(buildHostname('myapp', slashBranch)).toBe('feat-auth.myapp.localhost')
  })

  it('respects custom TLD', () => {
    expect(buildHostname('myapp', noWorktree, 'test')).toBe('myapp.test')
    expect(buildHostname('myapp', withWorktree, 'test')).toBe('fix-ui.myapp.test')
  })

  it('handles subdomain service names', () => {
    expect(buildHostname('api.myapp', noWorktree)).toBe('api.myapp.localhost')
  })
})

import { execSafe } from '../utils/exec.js'
import { sanitizeName } from './name-inferrer.js'

export interface WorktreeInfo {
  isLinkedWorktree: boolean
  branch: string | null
  sanitizedBranch: string | null
}

interface WorktreeEntry {
  worktree: string
  branch: string | null
  isMain: boolean
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Format per entry (blank-line separated):
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<name>   ← optional (detached HEAD has none)
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  const blocks = output.trim().split(/\n\n+/)

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].trim().split('\n')
    const worktreeLine = lines.find((l) => l.startsWith('worktree '))
    const branchLine = lines.find((l) => l.startsWith('branch '))

    if (!worktreeLine) continue

    const worktree = worktreeLine.slice('worktree '.length).trim()
    const rawBranch = branchLine
      ? branchLine.slice('branch '.length).trim()
      : null

    // Strip refs/heads/ prefix
    const branch = rawBranch?.replace(/^refs\/heads\//, '') ?? null

    entries.push({
      worktree,
      branch,
      isMain: i === 0, // first entry is always the main worktree
    })
  }

  return entries
}

/**
 * Normalize a path for comparison — resolve trailing slashes, lowercase on
 * case-insensitive filesystems (macOS). We keep it simple: trim + normalize
 * separators so string comparison is reliable.
 */
function normalizePath(p: string): string {
  return p.trim().replace(/\/+$/, '')
}

/**
 * Detect whether `cwd` is a linked git worktree and return branch info.
 *
 * Returns:
 *   { isLinkedWorktree: false }  — main worktree or not a git repo
 *   { isLinkedWorktree: true, branch, sanitizedBranch }  — linked worktree
 */
export async function getWorktreeInfo(cwd: string): Promise<WorktreeInfo> {
  const result = await execSafe('git worktree list --porcelain', cwd)

  if (!result || !result.stdout.trim()) {
    return { isLinkedWorktree: false, branch: null, sanitizedBranch: null }
  }

  const entries = parseWorktreeList(result.stdout)

  if (entries.length === 0) {
    return { isLinkedWorktree: false, branch: null, sanitizedBranch: null }
  }

  const normalizedCwd = normalizePath(cwd)
  const match = entries.find(
    (e) => normalizePath(e.worktree) === normalizedCwd
  )

  // cwd not in list (shouldn't happen), or it IS the main worktree
  if (!match || match.isMain) {
    return { isLinkedWorktree: false, branch: null, sanitizedBranch: null }
  }

  const branch = match.branch
  const sanitizedBranch = branch ? sanitizeName(branch) : null

  return { isLinkedWorktree: true, branch, sanitizedBranch }
}

/**
 * Build the full hostname for a service, incorporating worktree prefix if present.
 *
 * Examples:
 *   main worktree:          myapp.localhost
 *   branch "fix-ui":        fix-ui.myapp.localhost
 *   branch "feat/auth":     feat-auth.myapp.localhost
 */
export function buildHostname(
  baseName: string,
  worktreeInfo: WorktreeInfo,
  tld = 'localhost'
): string {
  const prefix = worktreeInfo.isLinkedWorktree && worktreeInfo.sanitizedBranch
    ? `${worktreeInfo.sanitizedBranch}.`
    : ''
  return `${prefix}${baseName}.${tld}`
}

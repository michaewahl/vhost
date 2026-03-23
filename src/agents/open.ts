import { platform } from 'node:os'
import { spawn } from 'node:child_process'

/**
 * Open a URL in the user's default browser.
 * Uses spawn with shell: false to prevent command injection.
 */
export async function openInBrowser(url: string): Promise<void> {
  // Validate URL to prevent injection
  const parsed = new URL(url) // throws on invalid URL
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Disallowed URL protocol: ${parsed.protocol}`)
  }

  const plat = platform()
  let bin: string
  let args: string[]

  if (plat === 'darwin') {
    bin = 'open'
    args = [url]
  } else if (plat === 'win32') {
    bin = 'cmd.exe'
    args = ['/c', 'start', '', url]
  } else {
    bin = 'xdg-open'
    args = [url]
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('close', () => resolve())
  })
}

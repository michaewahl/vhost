import { createServer } from 'node:net'

const DEFAULT_RANGE: [number, number] = [4000, 4999]
const MAX_RETRIES = 20

/**
 * Check if a port is available by attempting a real TCP bind.
 * More reliable than just checking — avoids TOCTOU race conditions.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Pick a random integer in [min, max] inclusive.
 */
function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Find a free port in the given range via random sampling.
 * Retries up to MAX_RETRIES times before throwing.
 */
export async function findFreePort(
  range: [number, number] = DEFAULT_RANGE
): Promise<number> {
  const [min, max] = range

  if (min > max) {
    throw new RangeError(`Invalid port range: ${min}–${max}`)
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const port = randomInRange(min, max)
    if (await isPortAvailable(port)) {
      return port
    }
  }

  throw new Error(
    `Could not find a free port in range ${min}–${max} after ${MAX_RETRIES} attempts`
  )
}

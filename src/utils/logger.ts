const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const DIM = '\x1b[2m'

export const logger = {
  success: (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`),
  info: (msg: string) => console.log(`${CYAN}→${RESET} ${msg}`),
  warn: (msg: string) => console.warn(`${YELLOW}⚠${RESET}  ${msg}`),
  error: (msg: string) => console.error(`${RED}✗${RESET} ${msg}`),
  dim: (msg: string) => console.log(`${DIM}${msg}${RESET}`),
  url: (label: string, url: string) =>
    console.log(`\n  ${GREEN}✓${RESET} ${label}: ${CYAN}${url}${RESET}\n`),
}

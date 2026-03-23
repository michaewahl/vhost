# vhost — Master Spec
### Nginx + mkcert + Thin Node.js CLI + Agent Architecture

---

## The Core Insight

Portless reimplements in Node.js what Nginx has done in production for 20 years.
This build wraps battle-tested infrastructure with a thin CLI instead.

```
vhost myapp next dev   →   same UX as portless
                            Nginx does the proxying
                            mkcert handles certs
                            ~400 lines of TS orchestrates it
```

---

## Architecture Overview

```
CLI (vhost <n> <cmd>)
  └── Orchestrator
        ├── Agent 1: Port Manager         finds free port in 4000–4998
        ├── Agent 2: Name Inferrer        package.json → git root → cwd name
        ├── Agent 3: Git Worktree         branch detection → subdomain prefix
        ├── Agent 4: Nginx Config Writer  writes server block, triggers reload
        ├── Agent 5: Cert Manager         mkcert CA + wildcard cert (one-time)
        ├── Agent 6: Hosts Manager        /etc/hosts sync for custom TLDs
        ├── Agent 7: Process Supervisor   spawns dev server, injects PORT, cleanup
        ├── Agent 8: Dashboard Server     Express app at vhost.localhost
        └── Agent 9: Env Injector         reads vhost.config.json, writes .env.local

Infrastructure (system-level, not owned by this codebase)
  ├── Nginx          reverse proxy + virtual host routing + TLS termination
  └── mkcert         local CA generation + system trust store
```

### Request Flow

```
Browser → https://myapp.localhost
  → Nginx (port 443, TLS terminated via wildcard *.localhost cert)
  → proxy_pass http://127.0.0.1:4237
  → Your dev server (randomly assigned port, set via PORT env var)
```

No Node.js proxy daemon. No routes.json polling. No invented infrastructure.

---

## Agent Contracts

Each agent: single file, single export, 50–150 lines, no side effects outside its domain.

---

### Agent 1 — Port Manager
**File:** `src/agents/port-manager.ts`

**Responsibility:** Find an available port in the 4000–4998 range (4999 reserved for dashboard).

```typescript
export async function findFreePort(range?: [number, number]): Promise<number>
export function isPortAvailable(port: number): Promise<boolean>
```

**Logic:**
- Pick random port in range
- Attempt TCP bind to verify availability (not just check — avoids TOCTOU race)
- Retry up to 20 times before throwing
- Stateless utility

---

### Agent 2 — Name Inferrer
**File:** `src/agents/name-inferrer.ts`

```typescript
export async function inferName(cwd: string): Promise<string>
export function sanitizeName(raw: string): string
```

**Resolution order:**
1. `package.json` → `name` field (nearest ancestor walking up)
2. Git root directory name (`git rev-parse --show-toplevel`)
3. `basename(cwd)`

**Sanitization:** lowercase, replace `/` and spaces and special chars with `-`,
strip leading/trailing `-`, max 40 chars. Scoped packages: `@org/name` → `org-name`.

---

### Agent 3 — Git Worktree
**File:** `src/agents/git-worktree.ts`

```typescript
export interface WorktreeInfo {
  isLinkedWorktree: boolean
  branch: string | null
  sanitizedBranch: string | null
}

export async function getWorktreeInfo(cwd: string): Promise<WorktreeInfo>
export function buildHostname(baseName: string, worktreeInfo: WorktreeInfo, tld?: string): string
```

**Logic:**
- Run `git worktree list --porcelain`
- First entry = main worktree
- If cwd matches a non-first entry → linked worktree
- Sanitize branch: lowercase, replace `/` with `-`

**Output examples:**
```
main worktree:        myapp.localhost
branch "fix-ui":      fix-ui.myapp.localhost
branch "feat/auth":   feat-auth.myapp.localhost
```

---

### Agent 4 — Nginx Config Writer
**File:** `src/agents/nginx-config-writer.ts`

```typescript
export interface NginxRoute {
  hostname: string
  port: number
  https: boolean
  certFile?: string
  keyFile?: string
}

export async function writeRoute(route: NginxRoute): Promise<string>
export async function removeRoute(hostname: string): Promise<void>
export async function reloadNginx(): Promise<void>
export async function startNginx(): Promise<void>
export async function stopNginx(): Promise<void>
export async function isNginxRunning(): Promise<boolean>
export async function ensureMainConfig(): Promise<string>
export function buildServerBlock(route: NginxRoute): string
export function buildMainConfig(nginxDir: string): string
```

**Config per route** (`~/.vhost/nginx/conf.d/<hostname>.conf`):
```nginx
# vhost: myapp.localhost → 4237
server {
    listen 80;
    listen 443 ssl http2;
    server_name myapp.localhost;

    ssl_certificate     ~/.vhost/certs/localhost.pem;
    ssl_certificate_key ~/.vhost/certs/localhost-key.pem;

    location / {
        proxy_pass         http://127.0.0.1:4237;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host       $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**Nginx control:** uses Homebrew nginx on macOS (`/opt/homebrew/bin/nginx`),
`-c ~/.vhost/nginx/nginx.conf` — never touches system nginx.

---

### Agent 5 — Cert Manager
**File:** `src/agents/cert-manager.ts`

```typescript
export interface CertPaths { cert: string; key: string }

export async function isMkcertInstalled(): Promise<boolean>
export async function isCAInstalled(): Promise<boolean>
export async function installCA(): Promise<void>
export async function generateCert(domains: string[], certsDir?: string): Promise<CertPaths>
export async function ensureCerts(certsDir?: string): Promise<CertPaths>  // idempotent
export function getCertPaths(certsDir?: string): CertPaths
```

**Logic:**
- `ensureCerts` is the main entry point — checks if certs exist, skips if so
- Runs `mkcert -install` once to trust the CA
- Generates wildcard cert: `localhost *.localhost`
- Stores at `~/.vhost/certs/`

---

### Agent 6 — Hosts Manager
**File:** `src/agents/hosts-manager.ts`

```typescript
export async function addHost(hostname: string): Promise<void>
export async function removeHost(hostname: string): Promise<void>
export async function syncHosts(hostnames: string[]): Promise<void>
export async function cleanHosts(): Promise<void>
```

**Only active for custom TLDs** — `.localhost` resolves natively, no hosts file needed.

Managed block in `/etc/hosts`:
```
# vhost-start
127.0.0.1  myapp.test
# vhost-end
```

---

### Agent 7 — Process Supervisor
**File:** `src/agents/process-supervisor.ts`

```typescript
export interface SupervisorOptions {
  command: string
  args: string[]
  port: number
  hostname: string
  cwd: string
  onExit: () => Promise<void>
}

export function detectFrameworkInjection(command: string, args: string[], port: number): { extraArgs: string[] }
export function buildChildEnv(port: number, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export async function supervise(opts: SupervisorOptions): Promise<void>
```

**Framework flag injection** (for frameworks that ignore PORT env var):

| Detected by | Injected flags |
|---|---|
| `vite` in cmd | `--port <n> --host 127.0.0.1` |
| `astro` in cmd | `--port <n> --host 0.0.0.0` |
| `ng serve` | `--port <n>` |
| `react-router` | `--port <n>` |
| `expo start` | `--port <n>` |
| `react-native start` | `--port <n>` |

**Cleanup:** `onExit` is called on SIGINT, SIGTERM, and child exit. Guaranteed
to run once regardless of how the process dies.

---

### Agent 8 — Dashboard Server
**File:** `src/agents/dashboard-server.ts`

```typescript
export const DASHBOARD_HOSTNAME = 'vhost.localhost'
export const DASHBOARD_PORT = 4999

export async function startDashboard(opts?: { https: boolean; certFile?: string; keyFile?: string }): Promise<void>
export async function stopDashboard(): Promise<void>
export function isDashboardRoute(hostname: string): boolean
```

**Reserved route:** `vhost.localhost → 127.0.0.1:4999`

Starts automatically with the proxy. Registers its own nginx route via Agent 4.

**API:**
```
GET /api/routes → { routes: Routes, proxyUptime: number | null }
```

Routes exclude the dashboard's own entry. Reads `routes.json` on every request — no caching.

**UI:** Single self-contained HTML file (no build step). Vanilla JS. Shows:
- All active routes as a table
- Live (●) vs alias (◆) badge
- Clickable URLs
- Git branch per service
- Uptime derived from `startedAt`
- Port number

**Idempotent** — second call to `startDashboard` returns immediately.

---

### Agent 9 — Env Injector
**File:** `src/agents/env-injector.ts`

```typescript
export interface InjectedRoute { envVar: string; hostname: string }
export interface LocalproxyConfig { name?: string; inject?: Record<string, string> }

// Pure string transforms
export function buildEnvBlock(routes: InjectedRoute[]): string
export function applyEnvBlock(existing: string, block: string): string
export function removeEnvBlock(existing: string): string

// Config
export async function readConfig(projectDir: string): Promise<LocalproxyConfig>
export function resolveInjections(config: LocalproxyConfig, tld: string, https: boolean): InjectedRoute[]
export function resolveEnvFile(projectDir: string): string

// I/O
export async function injectEnvVars(opts: EnvInjectorOptions): Promise<void>
export async function cleanEnvVars(projectDir: string): Promise<void>
```

**Config file** (`vhost.config.json` at project root):
```json
{
  "name": "frontend",
  "inject": {
    "NEXT_PUBLIC_API_URL": "api.myapp",
    "NEXT_PUBLIC_AUTH_URL": "auth.myapp"
  }
}
```

When `api.myapp.localhost` comes online → `NEXT_PUBLIC_API_URL=https://api.myapp.localhost`
is written into `.env.local`. Removed on process exit.

**Managed block format:**
```
# vhost-start
NEXT_PUBLIC_API_URL=https://api.myapp.localhost
# vhost-end
```

**Env file targeting:** `.env.local` preferred → `.env` fallback → create `.env.local`

---

## Orchestrator
**File:** `src/orchestrator.ts`

Full run sequence:
```
1.  readConfig(cwd)           → name override? inject map?
2.  Name Inferrer             → baseName (config.name wins over inference)
3.  Git Worktree              → worktreePrefix
4.  Build hostname            → [prefix.]baseName.tld
5.  Collision check           → exit if route exists (unless VHOST_FORCE=1)
6.  Port Manager              → assignedPort (4000–4998)
7.  Cert Manager              → ensureCerts() (idempotent)
8.  Nginx Config Writer       → writeRoute + reloadNginx
9.  State                     → addRoute(hostname, port, branch)
10. Env Injector              → injectEnvVars (if inject map in config)
11. Print URL                 → ✓ https://myapp.localhost
12. Process Supervisor        → supervise(onExit: nginx cleanup + cleanEnvVars)

On exit:
  → removeRoute (nginx conf.d file deleted)
  → removeStateRoute (routes.json updated)
  → reloadNginx
  → cleanEnvVars (.env.local block removed)
```

Dashboard starts once at proxy start, not per `run` command.

---

## CLI Interface
**File:** `src/cli.ts`

```bash
# Run with inferred name (reads vhost.config.json if present)
vhost run next dev
vhost run --name myapp next dev

# Run with explicit name (shorthand — pre-processed before Commander)
vhost myapp next dev
vhost api.myapp pnpm start

# Route management
vhost list
vhost get myapp
vhost alias my-postgres 5432
vhost alias my-postgres 5432 --force
vhost alias --remove my-postgres

# Proxy control
vhost proxy stop

# One-time setup
vhost setup

# Bypass entirely
VHOST=0 pnpm dev
```

---

## State Directory

```
~/.vhost/
  nginx/
    nginx.conf                    main config (includes conf.d/*.conf)
    nginx.pid
    logs/
      error.log
      access.log
    conf.d/
      myapp.localhost.conf         one file per active route
      vhost.localhost.conf    dashboard (always present)
  certs/
    localhost.pem
    localhost-key.pem
  routes.json
```

**routes.json schema:**
```json
{
  "myapp.localhost": {
    "port": 4237,
    "alias": false,
    "createdAt": "2025-01-01T12:00:00Z",
    "startedAt": "2025-01-01T12:00:00Z",
    "branch": "main"
  },
  "my-postgres.localhost": {
    "port": 5432,
    "alias": true,
    "createdAt": "2025-01-01T12:00:00Z"
  }
}
```

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `VHOST_PORT` | Nginx listen port (HTTP) | `80` |
| `VHOST_HTTPS` | Set `1` to always use HTTPS | `1` |
| `VHOST_TLD` | Custom TLD | `localhost` |
| `VHOST_APP_PORT` | Fixed app port (skip random) | random 4000–4998 |
| `VHOST_SYNC_HOSTS` | Force /etc/hosts sync | off |
| `VHOST_STATE_DIR` | Override state directory | `~/.vhost` |
| `VHOST_FORCE` | Override route collision check | off |
| `VHOST` | Set `0` to bypass proxy entirely | enabled |

---

## One-Time Setup

```bash
brew install nginx mkcert nss
npm install -g vhost
vhost setup
```

`vhost setup` does:
1. Creates `~/.vhost/` directory structure
2. Runs `mkcert -install` (trusts local CA)
3. Generates `localhost *.localhost` cert
4. Writes `~/.vhost/nginx/nginx.conf`
5. Starts nginx
6. Starts dashboard server
7. Prints: ✓ Ready → http://vhost.localhost

---

## Project Structure

```
src/
  cli.ts
  orchestrator.ts
  agents/
    port-manager.ts
    name-inferrer.ts
    git-worktree.ts
    nginx-config-writer.ts
    cert-manager.ts
    hosts-manager.ts
    process-supervisor.ts
    dashboard-server.ts
    env-injector.ts
  dashboard/
    index.html
  utils/
    exec.ts
    logger.ts
    state.ts

tests/
  orchestrator.test.ts
  agents/
    port-manager.test.ts
    name-inferrer.test.ts
    git-worktree.test.ts
    nginx-config-writer.test.ts
    cert-manager.test.ts
    process-supervisor.test.ts
    dashboard-server.test.ts
    env-injector.test.ts

specs/
  features.md

package.json
tsconfig.json
vitest.config.ts
```

---

## Test Coverage Summary

| Agent | Tests | Approach |
|---|---|---|
| port-manager | 7 | Real TCP bind, occupied port detection |
| name-inferrer | 14 | Temp dirs, package.json walking, sanitization |
| git-worktree | 16 | Porcelain parser (pure), exec mocked for integration |
| nginx-config-writer | 21 | Pure config generation + temp dir file I/O |
| cert-manager | 7 | exec mocked, temp dirs for cert path tests |
| process-supervisor | 24 | Real child_process spawn, PORT env verification |
| env-injector | 31 | Pure string transforms + temp dir I/O |
| dashboard-server | 8 | Live Express + real HTTP fetch |
| orchestrator | 7 | All agents mocked, collision/list/get logic |
| **Total** | **135** | **0 failures** |

---

## What's Left (Phase 8+)

- `hosts-manager.ts` — custom TLD `/etc/hosts` management (lowest priority)
- `npm run build` copy step for `dashboard/index.html` → `dist/`
- `vhost proxy start` — boots nginx + dashboard as persistent background service

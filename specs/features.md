# vhost — Feature Specs
## Agent 8: Dashboard Server + Agent 9: Env Injector

---

## Agent 8 — Dashboard Server

### Overview

A lightweight Express app that ships inside vhost and runs as a reserved
service at `http://vhost.localhost`. Starts automatically alongside nginx.
No configuration required. Read-only view of `routes.json`.

### Reserved Route

```
vhost.localhost  →  127.0.0.1:<dashboard-port>
```

- Dashboard port: fixed at **4999** (excluded from random assignment range,
  which becomes 4000–4998)
- Nginx config written at startup just like any other route — same Agent 4 path
- Dashboard is always the first route registered on proxy start

### What It Shows

```
┌─────────────────────────────────────────────────────┐
│  vhost                            2 running     │
├─────────────────────────────────────────────────────┤
│  ● myapp.localhost              up 4m  branch: main  │
│    https://myapp.localhost                           │
│                                                      │
│  ● fix-ui.myapp.localhost       up 1m  branch: fix-ui│
│    https://fix-ui.myapp.localhost                    │
│                                                      │
│  ◆ my-postgres                  alias  port: 5432    │
│    http://my-postgres.localhost:1355                 │
└─────────────────────────────────────────────────────┘
```

Fields per route (all sourced from `routes.json`):
- Hostname → clickable URL
- Status: live process (●) vs alias (◆)
- Uptime — derived from `startedAt` timestamp (add to route entry)
- Git branch — stored in route entry at registration time
- Port — the assigned app port

### What It Does NOT Do

- No realtime log streaming
- No WebSocket connections
- No process management (start/stop from UI)
- No metrics or graphs
- No auth

Refresh the page to update. Simple is the point.

### State Changes Required

Add two fields to route entries in `routes.json`:

```json
{
  "myapp.localhost": {
    "port": 4237,
    "alias": false,
    "createdAt": "2025-01-01T12:00:00Z",
    "startedAt": "2025-01-01T12:00:00Z",
    "branch": "main"
  }
}
```

Both fields optional (aliases and routes registered before this feature won't
have them — dashboard renders gracefully without them).

### API

Single endpoint — dashboard is a single-page app with one data fetch:

```
GET /api/routes
→ { routes: Route[], proxyUptime: number }
```

The Express app reads `routes.json` on every request. No caching, no memory
state. File is the source of truth.

### Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Server | Express | Already a likely dep; minimal |
| Frontend | Single HTML file, vanilla JS | No build step, no framework |
| Styles | Inline CSS | Ships as one self-contained file |
| Transport | JSON over HTTP | No WebSockets |

The entire dashboard frontend is a single HTML string served by Express.
No separate build pipeline. No webpack. No React.

### File Structure

```
src/
  agents/
    dashboard-server.ts     Express app + startup logic
  dashboard/
    index.html              Full dashboard UI (single file, served as string)
```

### Agent Interface

```typescript
export interface DashboardOptions {
  port: number        // fixed: 4999
  stateDir: string    // reads routes.json from here
}

export async function startDashboard(opts: DashboardOptions): Promise<void>
export async function stopDashboard(): Promise<void>
export function isDashboardRoute(hostname: string): boolean
```

`startDashboard` is called once during `vhost proxy start`.
Registers its own nginx route via Agent 4 before returning.

### Tests

- `GET /api/routes` returns correct shape from a mock `routes.json`
- Uptime calculation is correct
- Dashboard route is excluded from user route namespace
- `isDashboardRoute` correctly identifies reserved hostname
- Express app starts and responds on assigned port
- Returns empty routes array gracefully when `routes.json` doesn't exist

---

## Agent 9 — Env Injector

### Overview

When a service comes online, automatically write its URL into dependent
projects' `.env.local` files. Wires microservices together without manual
config. Driven by an optional `vhost.config.json` in the project root.

### Config File

`vhost.config.json` — optional, lives at project root alongside
`package.json`:

```json
{
  "name": "frontend",
  "inject": {
    "NEXT_PUBLIC_API_URL": "api.myapp",
    "NEXT_PUBLIC_AUTH_URL": "auth.myapp"
  }
}
```

| Field | Description |
|-------|-------------|
| `name` | Service name override (replaces `--name` flag entirely) |
| `inject` | Map of env var name → service name to watch for |

When `api.myapp.localhost` comes online, `NEXT_PUBLIC_API_URL=https://api.myapp.localhost`
is written into this project's `.env.local`.

When `vhost` exits and cleans up, the injected lines are removed.

### Env File Targeting

Resolution order for which env file to write:
1. `.env.local` — preferred (Next.js, Vite, most modern frameworks)
2. `.env` — fallback if `.env.local` doesn't exist and no framework detected
3. Create `.env.local` if neither exists

Never write to `.env.production` or `.env.example`.

### Managed Block Format

Injected lines are wrapped in a comment block so they can be cleanly removed:

```
# vhost-start
NEXT_PUBLIC_API_URL=https://api.myapp.localhost
NEXT_PUBLIC_AUTH_URL=https://auth.myapp.localhost
# vhost-end
```

- Block is written/replaced atomically on each update
- On cleanup (process exit): block is removed entirely
- User content outside the block is never touched
- If block already exists: replace it in-place (don't append)

### Injection Trigger

Injection fires in the orchestrator after nginx route registration:

```
Agent 4: writeRoute + reloadNginx  ← route is live
Agent 9: injectEnvVars             ← .env.local updated
Agent 7: supervise                 ← process starts
```

On exit (onExit callback):
```
Agent 4: removeRoute + reloadNginx
Agent 9: cleanEnvVars              ← block removed from .env.local
```

### Cross-Project Wiring

The interesting case: `frontend` depends on `api.myapp`, but they're separate
projects in separate directories. How does frontend know when api is ready?

Answer: it doesn't need to. The inject block is written when `api.myapp` comes
online — regardless of what order services start. If frontend is already running,
it picks up the env var on next restart (standard dev workflow). If frontend
hasn't started yet, the var is already there when it does.

For hot-reloading env vars without restart: out of scope for v1. That's a
framework-level concern (Next.js handles it, Vite handles it).

### Cross-Project Resolution

The `inject` map values (`"api.myapp"`) resolve to URLs using the active TLD:

```
"api.myapp"  →  https://api.myapp.localhost   (default)
"api.myapp"  →  https://api.myapp.test        (if VHOST_TLD=test)
```

HTTPS used when certs are present, HTTP otherwise. Agent 9 reads this from
the active proxy config — no hardcoding.

### Agent Interface

```typescript
export interface EnvInjectorOptions {
  projectDir: string     // where to find .env.local
  routes: InjectedRoute[]
  tld: string
  https: boolean
}

export interface InjectedRoute {
  envVar: string         // e.g. "NEXT_PUBLIC_API_URL"
  hostname: string       // e.g. "api.myapp.localhost"
}

export interface LocalproxyConfig {
  name?: string
  inject?: Record<string, string>   // envVar → serviceName
}

export async function readConfig(projectDir: string): Promise<LocalproxyConfig>
export async function resolveInjections(
  config: LocalproxyConfig,
  tld: string,
  https: boolean
): Promise<InjectedRoute[]>

export async function injectEnvVars(opts: EnvInjectorOptions): Promise<void>
export async function cleanEnvVars(projectDir: string): Promise<void>

export function buildEnvBlock(routes: InjectedRoute[]): string
export function applyEnvBlock(existing: string, block: string): string
export function removeEnvBlock(existing: string): string
```

### Pure Functions (Fully Unit Testable)

`buildEnvBlock(routes)` — builds the managed block string
`applyEnvBlock(existing, block)` — replaces or appends block in file content
`removeEnvBlock(existing)` — strips managed block from file content

These three are pure string transforms. No I/O. Core of the test suite.

### File Structure

```
src/
  agents/
    env-injector.ts
  
tests/
  agents/
    env-injector.test.ts
```

### Tests

**Pure function tests:**
- `buildEnvBlock` formats correctly with comment delimiters
- `applyEnvBlock` appends block to file with no existing block
- `applyEnvBlock` replaces existing block in-place
- `applyEnvBlock` preserves content above and below the block
- `removeEnvBlock` removes block entirely
- `removeEnvBlock` is a no-op when no block exists
- `removeEnvBlock` preserves surrounding content

**Integration tests (temp dirs):**
- `injectEnvVars` creates `.env.local` if it doesn't exist
- `injectEnvVars` writes correct URL for each injected var
- `cleanEnvVars` removes block, leaves rest of file intact
- `readConfig` reads `vhost.config.json` correctly
- `readConfig` returns empty object when file doesn't exist
- `resolveInjections` builds correct hostname from service name + TLD

---

## Updated Orchestrator Sequence

With both features wired in:

```
vhost run next dev

1. readConfig(cwd)             → name override? inject map?
2. Name Inferrer               → baseName (config.name wins)
3. Git Worktree                → worktreePrefix
4. Build hostname              → myapp.localhost
5. Port Manager                → assignedPort
6. Cert Manager                → ensureCerts() (idempotent)
7. Nginx Config Writer         → writeRoute + reloadNginx
8. Env Injector                → injectEnvVars (if inject map present)
9. Print URL                   → ✓ https://myapp.localhost
10. Process Supervisor         → supervise(onExit: steps 7+8 cleanup)

On exit:
  → removeRoute + reloadNginx
  → cleanEnvVars
```

Dashboard server starts once at proxy start, not per-command.

---

## Build Order

| Phase | What | Notes |
|-------|------|-------|
| 5 (current) | Orchestrator + CLI | Wires phases 1–4 into working CLI |
| 6 | Agent 9: Env Injector | Pure functions first, easy wins |
| 7 | Agent 8: Dashboard Server | Express + single HTML file |
| 8 | Hosts Manager | Custom TLD only, lowest priority |

# vhost

Named `.localhost` URLs for local development. Powered by Nginx + mkcert + dnsmasq.

```
vhost myapp next dev
# => https://myapp.localhost
```

No custom proxy daemon. No invented infrastructure. Nginx does the proxying, mkcert handles certs, ~400 lines of TypeScript orchestrates it.

## How it works

```
Browser -> https://myapp.localhost
  -> dnsmasq (resolves *.localhost to 127.0.0.1)
  -> Nginx (port 443, TLS via wildcard *.localhost cert)
  -> proxy_pass http://127.0.0.1:4237
  -> Your dev server (random port, injected via PORT env var)
```

## Install

```bash
# Prerequisites (vhost setup installs dnsmasq automatically if missing)
brew install nginx mkcert nss

# Install vhost
npm install -g vhost

# One-time setup (generates certs, trusts CA, configures DNS, starts nginx + dashboard)
vhost setup
```

## Usage

### Run a dev server

```bash
# Infer name from package.json / git root / directory name
vhost run next dev

# Explicit name
vhost myapp next dev

# With options
vhost run --name myapp --https next dev
```

Your dev server starts on a random port (4000-4998), Nginx proxies `https://myapp.localhost` to it. When you hit Ctrl+C, the route is cleaned up automatically.

### Git worktree support

If you're in a linked git worktree, the branch name becomes a subdomain:

```
main worktree:        https://myapp.localhost
branch "fix-ui":      https://fix-ui.myapp.localhost
branch "feat/auth":   https://feat-auth.myapp.localhost
```

### Multi-service workspace

Create `vhost.workspace.json` in your monorepo root:

```json
{
  "services": {
    "frontend": {
      "path": "./frontend",
      "command": "next dev",
      "inject": {
        "NEXT_PUBLIC_API_URL": "api"
      }
    },
    "api": {
      "path": "./api",
      "command": "pnpm start"
    },
    "auth": {
      "path": "./auth",
      "command": "node server.js",
      "port": 4100
    }
  }
}
```

```bash
vhost up
# => https://frontend.localhost
# => https://api.localhost
# => https://auth.localhost
```

All services start in parallel. Env injection wires them together automatically — `NEXT_PUBLIC_API_URL=https://api.localhost` is written to `frontend/.env.local`.

### Dashboard

`vhost setup` starts a web dashboard at **http://vhost.localhost** showing all active routes, their status (live vs alias), git branch, port, and uptime. Refresh to update.

```bash
vhost open              # open dashboard in browser
vhost open myapp        # open a specific service
```

### Route management

```bash
vhost list                          # Show all active routes
vhost get myapp                     # Print URL for a service
vhost open myapp                    # Open in browser
vhost open                          # Open dashboard

# Static aliases for external services (Docker, databases, etc.)
vhost alias my-postgres 5432
vhost alias --remove my-postgres
```

### Env injection

Create `vhost.config.json` in any project:

```json
{
  "name": "frontend",
  "inject": {
    "NEXT_PUBLIC_API_URL": "api.myapp",
    "NEXT_PUBLIC_AUTH_URL": "auth.myapp"
  }
}
```

When `api.myapp.localhost` comes online, `NEXT_PUBLIC_API_URL=https://api.myapp.localhost` is written to `.env.local`. Removed on exit.

### System health

```bash
vhost doctor
```

Checks nginx, mkcert, CA trust, certs, config, ports, and active routes.

### Proxy control

```bash
vhost setup                         # One-time init
vhost proxy stop                    # Stop nginx daemon
```

## Commands

| Command | Description |
|---|---|
| `vhost run <cmd> [args]` | Run dev server with inferred name |
| `vhost <name> <cmd> [args]` | Run dev server with explicit name |
| `vhost up` | Start all services from `vhost.workspace.json` |
| `vhost list` | Show active routes |
| `vhost get <name>` | Print URL for a service |
| `vhost open [name]` | Open service in browser (no args = dashboard) |
| `vhost alias <name> <port>` | Register static route |
| `vhost alias --remove <name>` | Remove static route |
| `vhost doctor` | Check system health |
| `vhost setup` | One-time setup |
| `vhost proxy stop` | Stop nginx |

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `VHOST_TLD` | Custom TLD | `localhost` |
| `VHOST_HTTPS` | Force HTTPS (`1` to enable) | off |
| `VHOST_APP_PORT` | Pin a specific app port | random 4000-4998 |
| `VHOST_STATE_DIR` | Override state directory | `~/.vhost` |
| `VHOST_FORCE` | Override route collision check | off |

## Framework support

vhost sets `PORT` and `HOST` env vars on the child process. For frameworks that ignore `PORT`, CLI flags are injected automatically:

| Framework | Injected flags |
|---|---|
| Next.js | _(respects PORT natively)_ |
| Vite | `--port <n> --host 127.0.0.1` |
| Astro | `--port <n> --host 0.0.0.0` |
| Angular | `--port <n>` |
| React Router | `--port <n>` |
| Expo | `--port <n>` |
| React Native | `--port <n>` |

## Architecture

```
CLI (vhost <name> <cmd>)
  -> Orchestrator
       |-- Port Manager         random port 4000-4998
       |-- Name Inferrer        package.json / git root / cwd
       |-- Git Worktree         branch -> subdomain prefix
       |-- Nginx Config Writer  server block + reload
       |-- Cert Manager         mkcert CA + wildcard cert
       |-- Process Supervisor   spawn, inject PORT, cleanup
       |-- Dashboard Server     Express at vhost.localhost:4999
       |-- Env Injector         .env.local managed block
       |-- Workspace            vhost.workspace.json compose
       |-- Doctor               system health checks
       |-- Open                 browser launcher
```

## State directory

```
~/.vhost/
  nginx/
    nginx.conf
    nginx.pid
    logs/
    conf.d/
      myapp.localhost.conf
  certs/
    localhost.pem
    localhost-key.pem
  routes.json
```

## Development

```bash
npm install
npm test            # 157 tests
npm run build       # tsc + copy dashboard HTML
npm run test:watch  # vitest watch mode
```

## License

MIT

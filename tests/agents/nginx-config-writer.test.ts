import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildServerBlock,
  buildMainConfig,
  writeRoute,
  removeRoute,
  ensureMainConfig,
} from '../../src/agents/nginx-config-writer.js'
import type { NginxRoute } from '../../src/agents/nginx-config-writer.js'

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `lp-nginx-test-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ─── buildServerBlock (pure) ─────────────────────────────────────────────────

describe('buildServerBlock', () => {
  const baseRoute: NginxRoute = {
    hostname: 'myapp.localhost',
    port: 4237,
    https: false,
  }

  it('includes the correct server_name', () => {
    const config = buildServerBlock(baseRoute)
    expect(config).toContain('server_name myapp.localhost;')
  })

  it('includes proxy_pass pointing to correct port', () => {
    const config = buildServerBlock(baseRoute)
    expect(config).toContain('proxy_pass         http://127.0.0.1:4237;')
  })

  it('includes WebSocket upgrade headers', () => {
    const config = buildServerBlock(baseRoute)
    expect(config).toContain('proxy_set_header   Upgrade')
    expect(config).toContain('proxy_set_header   Connection')
  })

  it('listens on 127.0.0.1:80 without https', () => {
    const config = buildServerBlock(baseRoute)
    expect(config).toContain('listen 127.0.0.1:80;')
    expect(config).not.toContain('listen 127.0.0.1:443')
  })

  it('listens on 443 with https enabled', () => {
    const route: NginxRoute = {
      ...baseRoute,
      https: true,
      certFile: '/home/user/.vhost/certs/localhost.pem',
      keyFile: '/home/user/.vhost/certs/localhost-key.pem',
    }
    const config = buildServerBlock(route)
    expect(config).toContain('listen 127.0.0.1:443 ssl;')
    expect(config).toContain('http2 on;')
    expect(config).toContain('listen 127.0.0.1:80;')
  })

  it('includes ssl_certificate paths when https is enabled', () => {
    const route: NginxRoute = {
      ...baseRoute,
      https: true,
      certFile: '/path/to/localhost.pem',
      keyFile: '/path/to/localhost-key.pem',
    }
    const config = buildServerBlock(route)
    expect(config).toContain('ssl_certificate     /path/to/localhost.pem;')
    expect(config).toContain('ssl_certificate_key /path/to/localhost-key.pem;')
  })

  it('omits ssl directives when https is false', () => {
    const config = buildServerBlock(baseRoute)
    expect(config).not.toContain('ssl_certificate')
  })

  it('includes a comment header identifying the route', () => {
    const config = buildServerBlock(baseRoute)
    expect(config).toContain('# vhost: myapp.localhost → 4237')
  })

  it('handles subdomain hostnames', () => {
    const route: NginxRoute = { ...baseRoute, hostname: 'api.myapp.localhost', port: 4300 }
    const config = buildServerBlock(route)
    expect(config).toContain('server_name api.myapp.localhost;')
    expect(config).toContain('proxy_pass         http://127.0.0.1:4300;')
  })
})

// ─── buildMainConfig (pure) ──────────────────────────────────────────────────

describe('buildMainConfig', () => {
  it('includes include directive pointing to conf.d', () => {
    const config = buildMainConfig('/home/user/.vhost/nginx')
    expect(config).toContain('include /home/user/.vhost/nginx/conf.d/*.conf;')
  })

  it('includes pid file path', () => {
    const config = buildMainConfig('/home/user/.vhost/nginx')
    expect(config).toContain('pid        /home/user/.vhost/nginx/nginx.pid;')
  })

  it('includes error log path', () => {
    const config = buildMainConfig('/home/user/.vhost/nginx')
    expect(config).toContain('error_log  /home/user/.vhost/nginx/logs/error.log')
  })

  it('includes WebSocket map block', () => {
    const config = buildMainConfig('/tmp/nginx')
    expect(config).toContain('map $http_upgrade $connection_upgrade')
  })
})

// ─── writeRoute ──────────────────────────────────────────────────────────────

describe('writeRoute', () => {
  it('writes a .conf file to the confd directory', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const route: NginxRoute = { hostname: 'myapp.localhost', port: 4237, https: false }
      const configPath = await writeRoute(route, dir)

      expect(configPath).toBe(join(dir, 'myapp.localhost.conf'))
      expect(existsSync(configPath)).toBe(true)

      const content = await readFile(configPath, 'utf-8')
      expect(content).toContain('server_name myapp.localhost;')
    } finally {
      await cleanup()
    }
  })

  it('creates the confd directory if it does not exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const confd = join(dir, 'conf.d')
      const route: NginxRoute = { hostname: 'test.localhost', port: 4500, https: false }
      await writeRoute(route, confd)
      expect(existsSync(confd)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('overwrites existing config for same hostname', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const route: NginxRoute = { hostname: 'myapp.localhost', port: 4237, https: false }
      await writeRoute(route, dir)

      const updated: NginxRoute = { hostname: 'myapp.localhost', port: 4999, https: false }
      await writeRoute(updated, dir)

      const content = await readFile(join(dir, 'myapp.localhost.conf'), 'utf-8')
      expect(content).toContain('4999')
      expect(content).not.toContain('4237')
    } finally {
      await cleanup()
    }
  })
})

// ─── removeRoute ─────────────────────────────────────────────────────────────

describe('removeRoute', () => {
  it('removes the config file for a hostname', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const confPath = join(dir, 'myapp.localhost.conf')
      await writeFile(confPath, '# test')
      expect(existsSync(confPath)).toBe(true)

      await removeRoute('myapp.localhost', dir)
      expect(existsSync(confPath)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('does not throw if the config file does not exist', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await expect(removeRoute('nonexistent.localhost', dir)).resolves.not.toThrow()
    } finally {
      await cleanup()
    }
  })
})

// ─── ensureMainConfig ────────────────────────────────────────────────────────

describe('ensureMainConfig', () => {
  it('creates nginx.conf and required directories', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const configPath = await ensureMainConfig(dir)

      expect(configPath).toBe(join(dir, 'nginx.conf'))
      expect(existsSync(configPath)).toBe(true)
      expect(existsSync(join(dir, 'logs'))).toBe(true)
      expect(existsSync(join(dir, 'conf.d'))).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('does not overwrite an existing nginx.conf', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      const configPath = join(dir, 'nginx.conf')
      await writeFile(configPath, '# custom config')

      await ensureMainConfig(dir)

      const content = await readFile(configPath, 'utf-8')
      expect(content).toBe('# custom config')
    } finally {
      await cleanup()
    }
  })

  it('written config contains include directive', async () => {
    const { dir, cleanup } = await makeTempDir()
    try {
      await ensureMainConfig(dir)
      const content = await readFile(join(dir, 'nginx.conf'), 'utf-8')
      expect(content).toContain('conf.d/*.conf')
    } finally {
      await cleanup()
    }
  })
})

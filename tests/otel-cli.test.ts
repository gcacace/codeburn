import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, it, expect } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
    },
    encoding: 'utf-8',
  })
}

type ConfigFile = { otel?: { enabled?: boolean; endpoint?: string; resourceAttributes?: Record<string, string>; sigv4?: { region?: string; service?: string; profile?: string }; headersHelper?: string } }

function readConfigFile(home: string): Promise<ConfigFile> {
  return readFile(join(home, '.config', 'codeburn', 'config.json'), 'utf-8').then(r => JSON.parse(r) as ConfigFile)
}

describe('codeburn otel set', () => {
  it('set --endpoint updates config and enables', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-otel-cli-'))
    try {
      const result = runCli(['otel', 'set', '--endpoint', 'https://otel.example.com:4318'], home)
      expect(result.status).toBe(0)
      const config = await readConfigFile(home)
      expect(config.otel?.endpoint).toBe('https://otel.example.com:4318')
      expect(config.otel?.enabled).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('set --resource-attr adds without clobbering existing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-otel-cli-'))
    try {
      runCli(['otel', 'set', '--endpoint', 'https://x.com', '--resource-attr', 'env=prod'], home)
      const r = runCli(['otel', 'set', '--resource-attr', 'team=infra'], home)
      expect(r.status).toBe(0)
      const config = await readConfigFile(home)
      expect(config.otel?.resourceAttributes).toEqual({ env: 'prod', team: 'infra' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('set --sigv4-region + --sigv4-service sets sigv4 config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-otel-cli-'))
    try {
      const result = runCli(['otel', 'set', '--endpoint', 'https://x.com', '--sigv4-region', 'us-west-2', '--sigv4-service', 'aps'], home)
      expect(result.status).toBe(0)
      const config = await readConfigFile(home)
      expect(config.otel?.sigv4?.region).toBe('us-west-2')
      expect(config.otel?.sigv4?.service).toBe('aps')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('codeburn otel reset', () => {
  it('removes otel section from config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-otel-cli-'))
    try {
      runCli(['otel', 'set', '--endpoint', 'https://x.com'], home)
      const before = await readConfigFile(home)
      expect(before.otel).toBeDefined()

      const result = runCli(['otel', 'reset'], home)
      expect(result.status).toBe(0)

      const after = await readConfigFile(home)
      expect(after.otel).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

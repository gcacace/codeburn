import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { readOtelConfig, saveConfig, readConfig } from '../src/config.js'
import type { OtelConfig } from '../src/config.js'

const fullOtel: OtelConfig = {
  enabled: true,
  endpoint: 'https://otel.example.com:4318',
  protocol: 'http/protobuf',
  headers: { 'x-api-key': 'secret123' },
  headersHelper: '/usr/local/bin/get-token',
  headersHelperIntervalMs: 60000,
  resourceAttributes: { 'service.name': 'codeburn', 'deployment.environment': 'prod' },
  sigv4: { region: 'us-west-2', service: 'xray', profile: 'dev' },
}

function withTmpHome(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-otel-test-'))
    const prev = process.env['HOME']
    process.env['HOME'] = dir
    try {
      await fn(dir)
    } finally {
      if (prev === undefined) delete process.env['HOME']
      else process.env['HOME'] = prev
      await rm(dir, { recursive: true, force: true })
    }
  }
}

describe('readOtelConfig', () => {
  it('parses config with full otel section', withTmpHome(async () => {
    await saveConfig({ otel: fullOtel })
    const result = await readOtelConfig()
    expect(result).toEqual(fullOtel)
  }))

  it('returns null when otel.enabled is false', withTmpHome(async () => {
    await saveConfig({ otel: { ...fullOtel, enabled: false } })
    expect(await readOtelConfig()).toBeNull()
  }))

  it('returns null when no otel key exists', withTmpHome(async () => {
    await saveConfig({})
    expect(await readOtelConfig()).toBeNull()
  }))

  it('round-trips through save/read preserving all otel fields', withTmpHome(async () => {
    await saveConfig({ otel: fullOtel })
    const config = await readConfig()
    expect(config.otel).toEqual(fullOtel)
  }))
})

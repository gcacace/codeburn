import { describe, it, expect } from 'vitest'
import { buildResource, emitOtelMetrics } from '../src/otel.js'
import type { OtelConfig } from '../src/config.js'
import type { PeriodData } from '../src/menubar-json.js'

const baseConfig: OtelConfig = {
  enabled: true,
  endpoint: 'http://localhost:4318/v1/metrics',
}

describe('buildResource', () => {
  it('includes service.name and service.version', () => {
    const resource = buildResource(baseConfig)
    expect(resource.attributes['service.name']).toBe('codeburn')
    expect(resource.attributes['service.version']).toBeTruthy()
  })

  it('merges user resourceAttributes', () => {
    const config: OtelConfig = {
      ...baseConfig,
      resourceAttributes: { 'deployment.environment': 'test', 'team': 'seal' },
    }
    const resource = buildResource(config)
    expect(resource.attributes['service.name']).toBe('codeburn')
    expect(resource.attributes['deployment.environment']).toBe('test')
    expect(resource.attributes['team']).toBe('seal')
  })
})

describe('emitOtelMetrics', () => {
  it('does not throw even with invalid endpoint', async () => {
    const config: OtelConfig = {
      enabled: true,
      endpoint: 'http://localhost:1/invalid',
    }
    const periodData: PeriodData = {
      label: 'test',
      cost: 0,
      calls: 0,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      categories: [],
      models: [],
    }
    await expect(emitOtelMetrics(config, periodData, null, [])).resolves.toBeUndefined()
  })
})

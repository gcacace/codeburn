import { describe, it, expect } from 'vitest'
import { buildResource, emitOtelMetrics } from '../src/otel.js'
import type { OtelConfig } from '../src/config.js'
import { emptyOtelSnapshot } from '../src/otel-metrics.js'

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

  it('auto-attaches pseudonymous device_id and host.name', () => {
    const resource = buildResource(baseConfig)
    // device_id is a salted hash (16 hex chars), never the raw host/user.
    expect(resource.attributes['codeburn.device_id']).toMatch(/^[0-9a-f]{16}$/)
    expect(resource.attributes['host.name']).toBeTruthy()
  })

  it('merges user resourceAttributes, which win over auto-attached keys', () => {
    const config: OtelConfig = {
      ...baseConfig,
      resourceAttributes: { 'deployment.environment': 'test', 'team': 'seal', 'host.name': 'override-host' },
    }
    const resource = buildResource(config)
    expect(resource.attributes['service.name']).toBe('codeburn')
    expect(resource.attributes['deployment.environment']).toBe('test')
    expect(resource.attributes['team']).toBe('seal')
    // Config attributes are spread last, so they override the auto-attached ones.
    expect(resource.attributes['host.name']).toBe('override-host')
  })
})

describe('emitOtelMetrics', () => {
  it('does not throw even with invalid endpoint', async () => {
    const config: OtelConfig = {
      enabled: true,
      endpoint: 'http://localhost:1/invalid',
    }
    await expect(emitOtelMetrics(config, emptyOtelSnapshot(), new Date())).resolves.toBeUndefined()
  })
})

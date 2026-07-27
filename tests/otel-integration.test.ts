import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { OtelConfig } from '../src/config.js'
import { emitOtelMetrics } from '../src/otel.js'
import { emptyOtelSnapshot, type OtelSnapshot } from '../src/otel-metrics.js'

const sampleSnapshot: OtelSnapshot = {
  ...emptyOtelSnapshot(),
  cost: 12.5,
  calls: 100,
  sessions: 5,
  inputTokens: 80000,
  outputTokens: 20000,
  cacheReadTokens: 20000,
  cacheWriteTokens: 5000,
  categories: [{ name: 'Coding', cost: 8, savingsUSD: 0, turns: 40, oneShotRate: 0.9 }],
  models: [{ name: 'claude-sonnet-4-6', calls: 80, cost: 10, savingsUSD: 0, estimatedCostUSD: 0 }],
  providers: [{ name: 'claude', cost: 12.5 }],
  retryTax: { totalUSD: 1, byModel: [{ name: 'claude-sonnet-4-6', taxUSD: 1, retriesPerEdit: 0.2 }] },
  optimize: {
    healthScore: 95,
    healthGrade: 'A',
    costRate: 0.01,
    findings: [],
    modelRecommendations: [],
  },
}

function startCollector(): Promise<{ server: Server; port: number; bodies: unknown[] }> {
  return new Promise((resolve) => {
    const bodies: unknown[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
        } catch { /* ignore */ }
        res.writeHead(200)
        res.end()
      })
    })
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port, bodies })
    })
  })
}

// Pull every emitted metric name out of an OTLP/JSON export body.
function metricNames(body: unknown): string[] {
  const names: string[] = []
  const rm = (body as { resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: Array<{ name?: string }> }> }> }).resourceMetrics ?? []
  for (const r of rm) for (const sm of r.scopeMetrics ?? []) for (const m of sm.metrics ?? []) {
    if (m.name) names.push(m.name)
  }
  return names
}

// Pull every data point's startTimeUnixNano (a JSON nanos string) out of an
// OTLP/JSON export body, across both sum and gauge metrics.
function startTimeNanos(body: unknown): string[] {
  const out: string[] = []
  type Pt = { startTimeUnixNano?: string }
  type Metric = { sum?: { dataPoints?: Pt[] }; gauge?: { dataPoints?: Pt[] } }
  const rm = (body as { resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: Metric[] }> }> }).resourceMetrics ?? []
  for (const r of rm) for (const sm of r.scopeMetrics ?? []) for (const m of sm.metrics ?? []) {
    for (const dp of m.sum?.dataPoints ?? []) if (dp.startTimeUnixNano) out.push(dp.startTimeUnixNano)
    for (const dp of m.gauge?.dataPoints ?? []) if (dp.startTimeUnixNano) out.push(dp.startTimeUnixNano)
  }
  return out
}

describe('emitOtelMetrics integration', () => {
  let collector: Awaited<ReturnType<typeof startCollector>> | null = null

  afterEach(async () => {
    if (collector) {
      await new Promise<void>((r) => collector!.server.close(() => r()))
      collector = null
    }
  })

  // Local midnight of an arbitrary fixed day; the exporter pins every data
  // point's startTimeUnixNano to this. JSON OTLP encodes it as a nanos string.
  const dayStart = new Date(2026, 0, 15)
  const expectedStartNanos = String(dayStart.getTime() * 1_000_000)

  it('sends valid OTLP JSON including enriched metrics to a mock collector', async () => {
    collector = await startCollector()
    const config: OtelConfig = {
      enabled: true,
      endpoint: `http://127.0.0.1:${collector.port}/v1/metrics`,
    }

    await emitOtelMetrics(config, sampleSnapshot, dayStart)

    expect(collector.bodies.length).toBeGreaterThanOrEqual(1)
    const body = collector.bodies[0] as { resourceMetrics?: unknown[] }
    expect(body).toHaveProperty('resourceMetrics')
    expect(Array.isArray(body.resourceMetrics)).toBe(true)

    // The enriched instruments actually make it onto the wire.
    const names = metricNames(body)
    expect(names).toContain('codeburn.cost.usage')
    expect(names).toContain('codeburn.retry_tax.usd')
    expect(names).toContain('codeburn.savings.local_model.usd')

    // Every cumulative data point is anchored to the fixed day-start — a stable
    // startTimeUnixNano, not the per-emit provider-creation time.
    const starts = startTimeNanos(body)
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.every(s => s === expectedStartNanos)).toBe(true)
  })

  it('does not throw when endpoint is unreachable', async () => {
    const config: OtelConfig = {
      enabled: true,
      endpoint: 'http://127.0.0.1:1/v1/metrics',
    }
    await expect(emitOtelMetrics(config, sampleSnapshot, dayStart)).resolves.toBeUndefined()
  })

  it('handles the empty snapshot without throwing', async () => {
    const config: OtelConfig = {
      enabled: true,
      endpoint: 'http://127.0.0.1:1/v1/metrics',
    }
    await expect(emitOtelMetrics(config, emptyOtelSnapshot(), dayStart)).resolves.toBeUndefined()
  })

  // NOTE: Fire-and-forget behavior (CLI not awaiting the OTEL promise, process exit timing)
  // should be tested manually or in E2E tests. Unit tests cannot reliably verify that
  // .catch(() => {}) swallows rejections in a detached promise context.
})

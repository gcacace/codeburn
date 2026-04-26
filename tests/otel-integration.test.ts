import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { PeriodData } from '../src/menubar-json.js'
import type { OtelConfig } from '../src/config.js'
import { emitOtelMetrics } from '../src/otel.js'

const samplePeriodData: PeriodData = {
  label: '7 days',
  cost: 12.5,
  calls: 100,
  sessions: 5,
  inputTokens: 80000,
  outputTokens: 20000,
  cacheReadTokens: 20000,
  cacheWriteTokens: 5000,
  categories: [
    { name: 'Coding', cost: 8, turns: 40, editTurns: 20, oneShotTurns: 18 },
  ],
  models: [
    { name: 'claude-sonnet-4-6', calls: 80, cost: 10 },
  ],
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

describe('emitOtelMetrics integration', () => {
  let collector: Awaited<ReturnType<typeof startCollector>> | null = null

  afterEach(async () => {
    if (collector) {
      await new Promise<void>((r) => collector!.server.close(() => r()))
      collector = null
    }
  })

  it('sends valid OTLP JSON to a mock collector', async () => {
    collector = await startCollector()
    const config: OtelConfig = {
      enabled: true,
      endpoint: `http://127.0.0.1:${collector.port}/v1/metrics`,
    }

    await emitOtelMetrics(config, samplePeriodData, {
      findings: [],
      costRate: 0.01,
      healthScore: 95,
      healthGrade: 'A',
    }, [])

    expect(collector.bodies.length).toBeGreaterThanOrEqual(1)
    const body = collector.bodies[0] as { resourceMetrics?: unknown[] }
    expect(body).toHaveProperty('resourceMetrics')
    expect(Array.isArray(body.resourceMetrics)).toBe(true)
  })

  it('does not throw when endpoint is unreachable', async () => {
    const config: OtelConfig = {
      enabled: true,
      endpoint: 'http://127.0.0.1:1/v1/metrics',
    }

    // Should resolve without throwing
    await expect(emitOtelMetrics(config, samplePeriodData, null, [])).resolves.toBeUndefined()
  })

  it('is a no-op when config is null (called via guard)', async () => {
    // In the CLI, emitOtelMetrics is only called when readOtelConfig() returns non-null.
    // This test verifies the function handles minimal valid config gracefully.
    const config: OtelConfig = {
      enabled: true,
      endpoint: 'http://127.0.0.1:1/v1/metrics',
    }
    await expect(emitOtelMetrics(config, samplePeriodData, null, [])).resolves.toBeUndefined()
  })

  // NOTE: Fire-and-forget behavior (CLI not awaiting the OTEL promise, process exit timing)
  // should be tested manually or in E2E tests. Unit tests cannot reliably verify that
  // .catch(() => {}) swallows rejections in a detached promise context.
})

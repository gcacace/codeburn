import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'

import { describe, expect, it } from 'vitest'

// End-to-end telemetry test: drive the REAL CLI against a synthetic session on
// disk, capture what it POSTs to a mock OTLP collector, and reconcile every
// emitted value against CodeBurn's OWN `today --format json` report for the same
// window. CodeBurn is its own oracle — if the wire numbers disagree with the
// report, a snapshot/mapping bug is present. This exercises the whole chain:
// disk → parse → buildMenubarPayloadForRange → buildOtelSnapshot →
// emitOtelMetrics → OTLP HTTP, plus the fire-and-forget flush on process exit.

// USD-per-million-token overrides pin the price so expected cost is exact and
// no network fetch can perturb it.
const PRICE_PER_M = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }
const MODEL = 'claude-sonnet-4-5'

// Async spawn (NOT spawnSync): the fire-and-forget OTEL export runs while the
// child is still alive, and the mock collector — which lives in THIS process's
// event loop — must be free to answer that POST. spawnSync would block the
// collector and deadlock the export until the child's 30s timeout.
function runCli(
  args: string[],
  home: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
        HOME: home,
        TZ: 'UTC',
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string, model: string, usage: Record<string, number>): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: { id: messageId, type: 'message', role: 'assistant', model, usage },
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({ type: 'user', sessionId, timestamp, message: { role: 'user', content: 'do the thing' } })
}

// Timestamps that reliably land in "today" (UTC) regardless of wall-clock hour,
// mirroring tests/cli-status-menubar.test.ts.
function todayTimestamps(count: number): string[] {
  const now = new Date()
  const h = now.getUTCHours()
  const base = h >= 2 ? new Date(now.getTime() - 2 * 3600_000) : new Date(now.getTime() - h * 3600_000 - 300_000)
  return Array.from({ length: count }, (_, i) =>
    new Date(base.getTime() + i * 60_000).toISOString().replace(/\.\d+Z$/, 'Z'),
  )
}

async function writeConfig(home: string, otel: Record<string, unknown>): Promise<void> {
  const cfgDir = join(home, '.config', 'codeburn')
  await mkdir(cfgDir, { recursive: true })
  await writeFile(join(cfgDir, 'config.json'), JSON.stringify({
    priceOverrides: { [MODEL]: PRICE_PER_M },
    otel,
  }))
}

// A mock OTLP/HTTP collector that records every POSTed body (parsed JSON).
function startCollector(): Promise<{ server: Server; port: number; bodies: unknown[] }> {
  return new Promise((resolve) => {
    const bodies: unknown[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try { bodies.push(JSON.parse(Buffer.concat(chunks).toString())) } catch { /* ignore */ }
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

// --- OTLP/JSON body accessors -------------------------------------------------

type Pt = { asInt?: string; asDouble?: number; attributes?: Array<{ key: string; value: Record<string, unknown> }> }
type Metric = { name: string; sum?: { dataPoints?: Pt[] }; gauge?: { dataPoints?: Pt[] } }

function metricsOf(body: unknown): Metric[] {
  const out: Metric[] = []
  const rm = (body as { resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: Metric[] }> }> }).resourceMetrics ?? []
  for (const r of rm) for (const sm of r.scopeMetrics ?? []) for (const m of sm.metrics ?? []) out.push(m)
  return out
}

function resourceAttrs(body: unknown): Record<string, string> {
  const rm = (body as { resourceMetrics?: Array<{ resource?: { attributes?: Array<{ key: string; value: Record<string, unknown> }> } }> }).resourceMetrics ?? []
  const attrs: Record<string, string> = {}
  for (const a of rm[0]?.resource?.attributes ?? []) {
    const v = a.value as { stringValue?: string }
    if (v.stringValue !== undefined) attrs[a.key] = v.stringValue
  }
  return attrs
}

function dataPoints(body: unknown, name: string): Pt[] {
  const m = metricsOf(body).find(x => x.name === name)
  return m?.sum?.dataPoints ?? m?.gauge?.dataPoints ?? []
}

function attr(p: Pt, key: string): string | undefined {
  const found = (p.attributes ?? []).find(a => a.key === key)
  return found ? (found.value as { stringValue?: string }).stringValue : undefined
}

function num(p: Pt | undefined): number | undefined {
  if (!p) return undefined
  if (p.asInt !== undefined) return Number(p.asInt)
  return p.asDouble
}

// Find the point on `name` whose attribute `key` equals `val`.
function point(body: unknown, name: string, key: string, val: string): Pt | undefined {
  return dataPoints(body, name).find(p => attr(p, key) === val)
}

// Poll for the collector to receive at least one body (the CLI emits
// fire-and-forget; spawnSync returns once the process exits, but the OS-buffered
// POST is handled by our event loop just after).
async function waitForBody(bodies: unknown[], timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (bodies.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 50))
  }
}

describe('OTEL end-to-end (CodeBurn as its own oracle)', () => {
  it('emitted metrics reconcile with the today --format json report', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-otel-e2e-'))
    const collector = await startCollector()
    try {
      await writeConfig(home, { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/metrics`, resourceAttributes: { department: 'eng', 'team.id': 'platform' } })

      const [t1, t2, t3, t4] = todayTimestamps(4)
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })
      // Two assistant calls, distinct message ids, both today.
      await writeFile(join(projectDir, 'session.jsonl'), [
        userLine('s1', t1),
        assistantLine('s1', t2, 'msg-1', MODEL, { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 }),
        userLine('s1', t3),
        assistantLine('s1', t4, 'msg-2', MODEL, { input_tokens: 300, output_tokens: 20 }),
      ].join('\n'))

      // Oracle: CodeBurn's own today report (raw USD, exact — convertCost at rate 1).
      const reportRun = await runCli(['today', '--format', 'json', '--provider', 'all'], home)
      expect(reportRun.status, `report stderr: ${reportRun.stderr}`).toBe(0)
      const report = JSON.parse(reportRun.stdout) as {
        overview: { cost: number; calls: number; sessions: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }
        models: Array<{ name: string; cost: number; calls: number }>
      }
      // Sanity: the fixture actually produced priced usage.
      expect(report.overview.calls).toBe(2)
      expect(report.overview.cost).toBeGreaterThan(0)

      // Emitter: the menubar today poll auto-emits OTEL fire-and-forget.
      const emitRun = await runCli(['status', '--format', 'menubar-json', '--period', 'today', '--provider', 'all', '--no-optimize'], home)
      expect(emitRun.status, `emit stderr: ${emitRun.stderr}`).toBe(0)
      await waitForBody(collector.bodies)
      expect(collector.bodies.length).toBeGreaterThanOrEqual(1)
      const body = collector.bodies[0]

      // --- Reconcile spend headline against the oracle ---
      expect(num(point(body, 'codeburn.cost.usage', 'provider', 'all'))).toBeCloseTo(report.overview.cost, 9)
      expect(num(point(body, 'codeburn.api_call.count', 'provider', 'all'))).toBe(report.overview.calls)
      expect(num(dataPoints(body, 'codeburn.session.count')[0])).toBe(report.overview.sessions)

      // --- Reconcile tokens by direction ---
      expect(num(point(body, 'codeburn.token.usage', 'type', 'input'))).toBe(report.overview.tokens.input)
      expect(num(point(body, 'codeburn.token.usage', 'type', 'output'))).toBe(report.overview.tokens.output)
      expect(num(point(body, 'codeburn.token.usage', 'type', 'cache_read'))).toBe(report.overview.tokens.cacheRead)
      expect(num(point(body, 'codeburn.token.usage', 'type', 'cache_write'))).toBe(report.overview.tokens.cacheWrite)

      // --- Per-model cost matches the report's single model row ---
      // The report labels the model with a friendly display name (e.g.
      // "Sonnet 4.5") while OTEL emits the raw machine name (the right choice
      // for a metric dimension). So reconcile on VALUE, not label: there is one
      // model in this fixture, so its OTEL cost/calls point must equal the
      // report's one model row and the grand total.
      expect(report.models).toHaveLength(1)
      const modelRow = report.models[0]
      const otelModelPoints = dataPoints(body, 'codeburn.cost.usage').filter(p => attr(p, 'model') !== undefined)
      expect(otelModelPoints).toHaveLength(1)
      expect(num(otelModelPoints[0])).toBeCloseTo(modelRow.cost, 9)
      const otelModelCalls = dataPoints(body, 'codeburn.api_call.count').filter(p => attr(p, 'model') !== undefined)
      expect(otelModelCalls).toHaveLength(1)
      expect(num(otelModelCalls[0])).toBe(modelRow.calls)

      // --- Each independent breakdown of cost.usage sums to the grand total ---
      const total = num(point(body, 'codeburn.cost.usage', 'provider', 'all'))!
      const byModel = dataPoints(body, 'codeburn.cost.usage').filter(p => attr(p, 'model') !== undefined)
      const byProvider = dataPoints(body, 'codeburn.cost.usage').filter(p => attr(p, 'provider') !== undefined && attr(p, 'provider') !== 'all')
      const byCategory = dataPoints(body, 'codeburn.cost.usage').filter(p => attr(p, 'category') !== undefined)
      const sum = (pts: Pt[]) => pts.reduce((s, p) => s + (num(p) ?? 0), 0)
      expect(sum(byModel)).toBeCloseTo(total, 9)
      expect(sum(byProvider)).toBeCloseTo(total, 9)
      expect(sum(byCategory)).toBeCloseTo(total, 9)

      // --- Deterministic absolute cost from the pinned price ---
      // (500*3 + 50*15 + 300*3 + 20*15) input/output + cache: 200 read * 0.3 + 100 write * 3.75, all /1e6
      const expected =
        (500 + 300) * PRICE_PER_M.input / 1e6 +
        (50 + 20) * PRICE_PER_M.output / 1e6 +
        200 * PRICE_PER_M.cacheRead / 1e6 +
        100 * PRICE_PER_M.cacheCreation / 1e6
      expect(total).toBeCloseTo(expected, 9)

      // --- Resource attributes: config + auto-attached identity ---
      const attrs = resourceAttrs(body)
      expect(attrs['service.name']).toBe('codeburn')
      expect(attrs['department']).toBe('eng')
      expect(attrs['team.id']).toBe('platform')
      expect(attrs['codeburn.device_id']).toMatch(/^[0-9a-f]{16}$/)
      expect(attrs['host.name']).toBeTruthy()

      // --- Start time anchored to UTC midnight of today (TZ=UTC) ---
      const now = new Date()
      const utcMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      const expectedStartNanos = String(utcMidnightMs * 1_000_000)
      const starts = metricsOf(body).flatMap(m => [...(m.sum?.dataPoints ?? []), ...(m.gauge?.dataPoints ?? [])])
        .map(p => (p as unknown as { startTimeUnixNano?: string }).startTimeUnixNano)
        .filter((s): s is string => !!s)
      expect(starts.length).toBeGreaterThan(0)
      expect(starts.every(s => s === expectedStartNanos)).toBe(true)
    } finally {
      await new Promise<void>((r) => collector.server.close(() => r()))
      await rm(home, { recursive: true, force: true })
    }
  }, 90_000)

  it('emits a valid zero payload for a day with no sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-otel-e2e-empty-'))
    const collector = await startCollector()
    try {
      await writeConfig(home, { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/metrics` })
      // Empty project dir — no sessions today.
      await mkdir(join(home, '.claude', 'projects', 'myapp'), { recursive: true })

      const emitRun = await runCli(['status', '--format', 'menubar-json', '--period', 'today', '--provider', 'all', '--no-optimize'], home)
      expect(emitRun.status, `emit stderr: ${emitRun.stderr}`).toBe(0)
      await waitForBody(collector.bodies)
      expect(collector.bodies.length).toBeGreaterThanOrEqual(1)
      const body = collector.bodies[0]

      // Zero data still emits the grand-total points (never crashes, no NaN).
      expect(num(point(body, 'codeburn.cost.usage', 'provider', 'all'))).toBe(0)
      expect(num(dataPoints(body, 'codeburn.session.count')[0])).toBe(0)
      // health.score defaults to a perfect 100 / grade A with no findings.
      const health = dataPoints(body, 'codeburn.health.score')[0]
      expect(num(health)).toBe(100)
      expect(attr(health, 'grade')).toBe('A')
    } finally {
      await new Promise<void>((r) => collector.server.close(() => r()))
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)

  it('anchors the start time to local midnight in the configured timezone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-otel-e2e-tz-'))
    const collector = await startCollector()
    try {
      await writeConfig(home, { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/metrics` })
      await mkdir(join(home, '.claude', 'projects', 'myapp'), { recursive: true })

      // Force a fixed IANA zone; the anchor must be that zone's local midnight.
      const tz = 'Asia/Tokyo'
      const emitRun = await runCli(['status', '--format', 'menubar-json', '--period', 'today', '--provider', 'all', '--no-optimize'], home, { TZ: tz })
      expect(emitRun.status, `emit stderr: ${emitRun.stderr}`).toBe(0)
      await waitForBody(collector.bodies)
      const body = collector.bodies[0]

      // Compute Tokyo's local-midnight-of-today as an epoch, the same way the CLI does.
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
      // en-CA gives YYYY-MM-DD; midnight in Tokyo (UTC+9, no DST) is that date at 00:00+09:00.
      const midnightMs = new Date(`${parts}T00:00:00+09:00`).getTime()
      const expectedStartNanos = String(midnightMs * 1_000_000)

      const starts = metricsOf(body).flatMap(m => [...(m.sum?.dataPoints ?? []), ...(m.gauge?.dataPoints ?? [])])
        .map(p => (p as unknown as { startTimeUnixNano?: string }).startTimeUnixNano)
        .filter((s): s is string => !!s)
      expect(starts.length).toBeGreaterThan(0)
      expect(starts.every(s => s === expectedStartNanos)).toBe(true)
    } finally {
      await new Promise<void>((r) => collector.server.close(() => r()))
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)
})

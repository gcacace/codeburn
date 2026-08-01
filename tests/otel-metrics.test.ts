import { describe, it, expect, beforeEach } from 'vitest'
import { MeterProvider, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import type { FindingId } from '../src/optimize.js'
import { classifyWasteDomain, recordMetrics, emptyOtelSnapshot, type OtelSnapshot } from '../src/otel-metrics.js'

// A rich snapshot exercising every dimension the instruments emit.
const sampleSnapshot: OtelSnapshot = {
  cost: 12.5,
  estimatedCostUSD: 1.25,
  proxiedCostUSD: 4,
  calls: 100,
  sessions: 5,
  inputTokens: 80000,
  outputTokens: 20000,
  reasoningTokens: 3000,
  cacheReadTokens: 20000,
  cacheWriteTokens: 5000,
  codexCredits: 7,
  pricingCoverage: 0.9,
  correctionRate: 0.25,
  categories: [
    { name: 'Coding', cost: 8, savingsUSD: 1, turns: 40, oneShotRate: 18 / 20 },
    { name: 'Debugging', cost: 3, savingsUSD: 0.5, turns: 15, oneShotRate: 5 / 10 },
    { name: 'Exploration', cost: 1.5, savingsUSD: 0, turns: 10, oneShotRate: null },
  ],
  models: [
    { name: 'claude-sonnet-4-6', cost: 10, calls: 80, savingsUSD: 0, estimatedCostUSD: 1.25 },
    { name: 'claude-haiku-3.5', cost: 2.5, calls: 20, savingsUSD: 0, estimatedCostUSD: 0 },
  ],
  providers: [
    { name: 'claude', cost: 11 },
    { name: 'codex', cost: 1.5 },
  ],
  modelEfficiency: [
    { name: 'claude-sonnet-4-6', costPerEdit: 0.5, oneShotRate: 0.9 },
    { name: 'claude-haiku-3.5', costPerEdit: 0.1, oneShotRate: null },
  ],
  retryTax: {
    totalUSD: 2,
    byModel: [
      { name: 'claude-sonnet-4-6', taxUSD: 1.5, retriesPerEdit: 0.4 },
      { name: 'claude-haiku-3.5', taxUSD: 0.5, retriesPerEdit: null },
    ],
  },
  routingWaste: {
    totalSavingsUSD: 3,
    baselineModel: 'claude-haiku-3.5',
    baselineCostPerEdit: 0.1,
    byModel: [{ name: 'claude-sonnet-4-6', savingsUSD: 3 }],
  },
  localModelSavings: {
    totalUSD: 6,
    byModel: [{ name: 'llama3.1:8b', savingsUSD: 6 }],
    byProvider: [{ name: 'ollama', savingsUSD: 6 }],
  },
  optimize: {
    healthScore: 71,
    healthGrade: 'C',
    costRate: 0.00001,
    findings: [
      { id: 'claude-md-too-long', impact: 'high', tokensSaved: 5000, trend: 'active' },
      { id: 'redundant-rereads', impact: 'medium', tokensSaved: 3000 },
      { id: 'bash-output-cap', impact: 'low', tokensSaved: 1000 },
    ],
    modelRecommendations: [
      { fromModel: 'claude-sonnet-4-6', toModel: 'claude-haiku-3.5', savingsPct: 42 },
    ],
  },
  tools: [
    { name: 'Read', calls: 120 },
    { name: 'Edit', calls: 45 },
    { name: 'Bash', calls: 30 },
  ],
  mcpServers: [
    { name: 'builder-mcp', calls: 12 },
    { name: 'chrome-devtools', calls: 4 },
  ],
  skills: [
    { name: 'crux-code-reviews', turns: 8, cost: 1.2 },
    { name: 'brazil', turns: 3, cost: 0.4 },
  ],
  subagents: [
    { name: 'planner', calls: 5, cost: 2.5 },
    { name: 'reviewer', calls: 2, cost: 0.8 },
  ],
}

async function collectMetrics(snapshot: OtelSnapshot) {
  const { MetricReader } = await import('@opentelemetry/sdk-metrics')

  // Custom reader that exposes collect() directly — avoids PeriodicExportingMetricReader
  // timing issues with ObservableCounter callbacks in tests.
  class TestReader extends MetricReader {
    protected onForceFlush(): Promise<void> { return Promise.resolve() }
    protected onShutdown(): Promise<void> { return Promise.resolve() }
    selectAggregationTemporality() { return AggregationTemporality.DELTA }
  }

  const reader = new TestReader()
  const provider = new MeterProvider({ readers: [reader] })
  const meter = provider.getMeter('test')

  recordMetrics(meter, snapshot)

  const { resourceMetrics } = await reader.collect()
  await provider.shutdown()

  const metrics = new Map<string, Array<{ value: number; attributes: Record<string, unknown> }>>()
  for (const sm of resourceMetrics.scopeMetrics) {
    for (const m of sm.metrics) {
      const points: Array<{ value: number; attributes: Record<string, unknown> }> = []
      for (const dp of m.dataPoints) {
        points.push({ value: dp.value as number, attributes: dp.attributes as Record<string, unknown> })
      }
      metrics.set(m.descriptor.name, [...(metrics.get(m.descriptor.name) ?? []), ...points])
    }
  }
  return metrics
}

describe('classifyWasteDomain', () => {
  const finding = (id: FindingId) => ({ id })

  it('classifies context_bloat findings', () => {
    expect(classifyWasteDomain(finding('claude-md-too-long'))).toBe('context_bloat')
    expect(classifyWasteDomain(finding('unused-agents'))).toBe('context_bloat')
    expect(classifyWasteDomain(finding('unused-skills'))).toBe('context_bloat')
    expect(classifyWasteDomain(finding('unused-commands'))).toBe('context_bloat')
  })

  it('classifies read_waste findings', () => {
    expect(classifyWasteDomain(finding('read-edit-ratio'))).toBe('read_waste')
    expect(classifyWasteDomain(finding('build-folder-reads'))).toBe('read_waste')
    expect(classifyWasteDomain(finding('redundant-rereads'))).toBe('read_waste')
  })

  it('classifies cache_waste findings', () => {
    expect(classifyWasteDomain(finding('warmup-heavy'))).toBe('cache_waste')
  })

  it('classifies config_waste findings', () => {
    expect(classifyWasteDomain(finding('bash-output-cap'))).toBe('config_waste')
  })

  it('classifies mcp_waste findings', () => {
    expect(classifyWasteDomain(finding('unused-mcp'))).toBe('mcp_waste')
    expect(classifyWasteDomain(finding('mcp-low-coverage'))).toBe('mcp_waste')
    expect(classifyWasteDomain(finding('mcp-deferral-off'))).toBe('mcp_waste')
  })

  it('classifies session_waste findings', () => {
    expect(classifyWasteDomain(finding('cost-outliers'))).toBe('session_waste')
    expect(classifyWasteDomain(finding('context-heavy-sessions'))).toBe('session_waste')
  })

  it('classifies retry_waste findings', () => {
    expect(classifyWasteDomain(finding('retry-heavy-capabilities'))).toBe('retry_waste')
  })

  it('defaults to other for an unmapped id', () => {
    expect(classifyWasteDomain({ id: 'totally-new-finding' as FindingId })).toBe('other')
  })
})

describe('recordMetrics', () => {
  let metrics: Map<string, Array<{ value: number; attributes: Record<string, unknown> }>>

  beforeEach(async () => {
    metrics = await collectMetrics(sampleSnapshot)
  })

  it('all metric names start with codeburn.', () => {
    for (const name of metrics.keys()) {
      expect(name).toMatch(/^codeburn\./)
    }
  })

  it('records health score with grade', () => {
    const points = metrics.get('codeburn.health.score')!
    expect(points).toHaveLength(1)
    expect(points[0].value).toBe(71)
    expect(points[0].attributes.grade).toBe('C')
  })

  it('records cache hit percent', () => {
    const points = metrics.get('codeburn.cache_hit.percent')!
    // 20000 / (80000 + 20000) * 100 = 20
    expect(points[0].value).toBe(20)
  })

  it('records pricing coverage when computable', () => {
    expect(metrics.get('codeburn.pricing.coverage')![0].value).toBe(0.9)
  })

  it('records self-correction rate', () => {
    expect(metrics.get('codeburn.workflow.correction_rate')![0].value).toBe(0.25)
  })

  it('records oneshot rate per activity with a defined rate', () => {
    const points = metrics.get('codeburn.oneshot.rate')!
    expect(points).toHaveLength(2) // Coding and Debugging, not Exploration (null)
    expect(points.find(p => p.attributes.activity === 'Coding')!.value).toBe(18 / 20)
    expect(points.find(p => p.attributes.activity === 'Debugging')!.value).toBe(5 / 10)
  })

  it('records per-model oneshot rate and cost per edit', () => {
    const oneShot = metrics.get('codeburn.model.oneshot_rate')!
    // Only claude-sonnet-4-6 has a non-null oneShotRate.
    expect(oneShot).toHaveLength(1)
    expect(oneShot.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(0.9)
    const costPerEdit = metrics.get('codeburn.model.cost_per_edit')!
    expect(costPerEdit.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(0.5)
    expect(costPerEdit.find(p => p.attributes.model === 'claude-haiku-3.5')!.value).toBe(0.1)
  })

  it('records per-model retry rate', () => {
    const points = metrics.get('codeburn.retry.rate')!
    // Only claude-sonnet-4-6 has a non-null retriesPerEdit.
    expect(points).toHaveLength(1)
    expect(points.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(0.4)
  })

  it('records the routing baseline cost per edit with its model', () => {
    const points = metrics.get('codeburn.routing.baseline_cost_per_edit')!
    expect(points[0].value).toBe(0.1)
    expect(points[0].attributes.model).toBe('claude-haiku-3.5')
  })

  it('records model-switch recommendations by from/to', () => {
    const points = metrics.get('codeburn.recommendation.savings_pct')!
    const rec = points.find(p => p.attributes.from_model === 'claude-sonnet-4-6' && p.attributes.to_model === 'claude-haiku-3.5')!
    expect(rec.value).toBe(42)
  })

  it('records health penalty by id-classified domain', () => {
    const points = metrics.get('codeburn.health.penalty')!
    // claude-md-too-long (high=15) -> context_bloat
    expect(points.find(p => p.attributes.domain === 'context_bloat')!.value).toBe(15)
    // redundant-rereads (medium=7) -> read_waste (id-based, no title regex)
    expect(points.find(p => p.attributes.domain === 'read_waste')!.value).toBe(7)
    // bash-output-cap (low=3) -> config_waste
    expect(points.find(p => p.attributes.domain === 'config_waste')!.value).toBe(3)
  })

  it('records cost per model, provider, category, and total', () => {
    const points = metrics.get('codeburn.cost.usage')!
    expect(points.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(10)
    expect(points.find(p => p.attributes.model === 'claude-haiku-3.5')!.value).toBe(2.5)
    // Genuine per-provider split.
    expect(points.find(p => p.attributes.provider === 'claude')!.value).toBe(11)
    expect(points.find(p => p.attributes.provider === 'codex')!.value).toBe(1.5)
    // Per activity category.
    expect(points.find(p => p.attributes.category === 'Coding')!.value).toBe(8)
    // Grand total.
    expect(points.find(p => p.attributes.provider === 'all')!.value).toBe(12.5)
  })

  it('records estimated and proxied cost', () => {
    const estimated = metrics.get('codeburn.cost.estimated')!
    expect(estimated.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(1.25)
    expect(estimated.find(p => p.attributes.provider === 'all')!.value).toBe(1.25)
    expect(metrics.get('codeburn.cost.proxied')![0].value).toBe(4)
  })

  it('records codex credits', () => {
    expect(metrics.get('codeburn.codex.credits')![0].value).toBe(7)
  })

  it('records token usage by type including reasoning', () => {
    const points = metrics.get('codeburn.token.usage')!
    expect(points.find(p => p.attributes.type === 'input')!.value).toBe(80000)
    expect(points.find(p => p.attributes.type === 'output')!.value).toBe(20000)
    expect(points.find(p => p.attributes.type === 'reasoning')!.value).toBe(3000)
    expect(points.find(p => p.attributes.type === 'cache_read')!.value).toBe(20000)
    expect(points.find(p => p.attributes.type === 'cache_write')!.value).toBe(5000)
  })

  it('records session count and per-model api calls', () => {
    expect(metrics.get('codeburn.session.count')![0].value).toBe(5)
    const calls = metrics.get('codeburn.api_call.count')!
    expect(calls.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(80)
    expect(calls.find(p => p.attributes.provider === 'all')!.value).toBe(100)
  })

  it('records activity turns per category', () => {
    const points = metrics.get('codeburn.activity.turns')!
    expect(points.find(p => p.attributes.category === 'Coding')!.value).toBe(40)
    expect(points.find(p => p.attributes.category === 'Debugging')!.value).toBe(15)
    expect(points.find(p => p.attributes.category === 'Exploration')!.value).toBe(10)
  })

  it('records tool calls per tool with no grand total', () => {
    const points = metrics.get('codeburn.tool.calls')!
    expect(points.find(p => p.attributes.tool === 'Read')!.value).toBe(120)
    expect(points.find(p => p.attributes.tool === 'Edit')!.value).toBe(45)
    expect(points.find(p => p.attributes.tool === 'Bash')!.value).toBe(30)
    // Top-N slice: no provider="all" grand total (summing a slice undercounts).
    expect(points.some(p => p.attributes.provider === 'all')).toBe(false)
  })

  it('records mcp server calls per server', () => {
    const points = metrics.get('codeburn.mcp.calls')!
    expect(points.find(p => p.attributes.mcp_server === 'builder-mcp')!.value).toBe(12)
    expect(points.find(p => p.attributes.mcp_server === 'chrome-devtools')!.value).toBe(4)
    expect(points.some(p => p.attributes.provider === 'all')).toBe(false)
  })

  it('records skill turns and cost per skill', () => {
    const turns = metrics.get('codeburn.skill.turns')!
    expect(turns.find(p => p.attributes.skill === 'crux-code-reviews')!.value).toBe(8)
    expect(turns.find(p => p.attributes.skill === 'brazil')!.value).toBe(3)
    const cost = metrics.get('codeburn.skill.cost')!
    expect(cost.find(p => p.attributes.skill === 'crux-code-reviews')!.value).toBeCloseTo(1.2, 10)
    expect(cost.find(p => p.attributes.skill === 'brazil')!.value).toBeCloseTo(0.4, 10)
  })

  it('records subagent calls and cost per subagent', () => {
    const calls = metrics.get('codeburn.subagent.calls')!
    expect(calls.find(p => p.attributes.subagent === 'planner')!.value).toBe(5)
    expect(calls.find(p => p.attributes.subagent === 'reviewer')!.value).toBe(2)
    const cost = metrics.get('codeburn.subagent.cost')!
    expect(cost.find(p => p.attributes.subagent === 'planner')!.value).toBeCloseTo(2.5, 10)
    expect(cost.find(p => p.attributes.subagent === 'reviewer')!.value).toBeCloseTo(0.8, 10)
  })

  it('records realized local-model savings by model, provider, and total', () => {
    const points = metrics.get('codeburn.savings.local_model.usd')!
    expect(points.find(p => p.attributes.model === 'llama3.1:8b')!.value).toBe(6)
    expect(points.find(p => p.attributes.provider === 'ollama')!.value).toBe(6)
    expect(points.find(p => p.attributes.provider === 'all')!.value).toBe(6)
  })

  it('records retry tax total and per model', () => {
    const points = metrics.get('codeburn.retry_tax.usd')!
    expect(points.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(1.5)
    expect(points.find(p => p.attributes.provider === 'all')!.value).toBe(2)
  })

  it('records routing waste total and per model', () => {
    const points = metrics.get('codeburn.routing_waste.usd')!
    expect(points.find(p => p.attributes.model === 'claude-sonnet-4-6')!.value).toBe(3)
    expect(points.find(p => p.attributes.provider === 'all')!.value).toBe(3)
  })

  it('records optimize findings by impact and by id', () => {
    const points = metrics.get('codeburn.optimize.findings')!
    expect(points.find(p => p.attributes.impact === 'high')!.value).toBe(1)
    expect(points.find(p => p.attributes.impact === 'medium')!.value).toBe(1)
    expect(points.find(p => p.attributes.impact === 'low')!.value).toBe(1)
    expect(points.find(p => p.attributes.id === 'claude-md-too-long')!.value).toBe(1)
    expect(points.find(p => p.attributes.id === 'redundant-rereads')!.value).toBe(1)
  })

  it('records saveable tokens total and per finding id', () => {
    const points = metrics.get('codeburn.optimize.savings_tokens')!
    expect(points.find(p => p.attributes.provider === 'all')!.value).toBe(9000)
    expect(points.find(p => p.attributes.id === 'claude-md-too-long')!.value).toBe(5000)
  })

  it('records dollarized optimize savings total and per finding id', () => {
    const points = metrics.get('codeburn.optimize.savings_usd')!
    // 9000 tokens * 0.00001 costRate
    expect(points.find(p => p.attributes.provider === 'all')!.value).toBeCloseTo(0.09, 10)
    expect(points.find(p => p.attributes.id === 'claude-md-too-long')!.value).toBeCloseTo(0.05, 10)
  })
})

describe('recordMetrics with empty data', () => {
  it('handles the empty snapshot', async () => {
    const metrics = await collectMetrics(emptyOtelSnapshot())
    // Gauges still emit with zero/default values.
    expect(metrics.get('codeburn.health.score')![0].value).toBe(100)
    expect(metrics.get('codeburn.health.score')![0].attributes.grade).toBe('A')
    expect(metrics.get('codeburn.cache_hit.percent')![0].value).toBe(0)
    // ObservableCounters with zero values still emit data points.
    expect(metrics.get('codeburn.session.count')![0].value).toBe(0)
    expect(metrics.get('codeburn.optimize.savings_tokens')!.find(p => p.attributes.provider === 'all')!.value).toBe(0)
    // A null pricingCoverage / correctionRate emits no gauge point at all.
    expect(metrics.has('codeburn.pricing.coverage')).toBe(false)
    expect(metrics.has('codeburn.workflow.correction_rate')).toBe(false)
    // Usage metrics observe nothing when their arrays are empty (no points).
    expect(metrics.get('codeburn.tool.calls') ?? []).toHaveLength(0)
    expect(metrics.get('codeburn.mcp.calls') ?? []).toHaveLength(0)
    expect(metrics.get('codeburn.skill.cost') ?? []).toHaveLength(0)
    expect(metrics.get('codeburn.subagent.cost') ?? []).toHaveLength(0)
  })

  it('handles a null optimize scan', async () => {
    const metrics = await collectMetrics({ ...sampleSnapshot, optimize: null })
    expect(metrics.get('codeburn.health.score')![0].value).toBe(100)
    expect(metrics.get('codeburn.health.score')![0].attributes.grade).toBe('A')
    // With no scan, findings observe only the zero-valued total.
    expect(metrics.get('codeburn.optimize.findings')!.every(p => p.value === 0)).toBe(true)
    expect(metrics.get('codeburn.optimize.savings_tokens')!.find(p => p.attributes.provider === 'all')!.value).toBe(0)
    // No model recommendations without a scan.
    expect(metrics.has('codeburn.recommendation.savings_pct')).toBe(false)
  })
})

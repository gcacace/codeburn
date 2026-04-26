import { describe, it, expect, beforeEach } from 'vitest'
import { MeterProvider, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import type { PeriodData } from '../src/menubar-json.js'
import type { OptimizeResult, WasteFinding } from '../src/optimize.js'
import { classifyWasteDomain, recordMetrics } from '../src/otel-metrics.js'

function makeFinding(title: string, impact: 'high' | 'medium' | 'low', tokensSaved = 1000): WasteFinding {
  return {
    title,
    explanation: 'test',
    impact,
    tokensSaved,
    fix: { type: 'paste', label: 'test', text: 'test' },
  }
}

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
    { name: 'Debugging', cost: 3, turns: 15, editTurns: 10, oneShotTurns: 5 },
    { name: 'Exploration', cost: 1.5, turns: 10, editTurns: 0, oneShotTurns: 0 },
  ],
  models: [
    { name: 'claude-sonnet-4-6', cost: 10, calls: 80 },
    { name: 'claude-haiku-3.5', cost: 2.5, calls: 20 },
  ],
}

const sampleOptimizeResult: OptimizeResult = {
  findings: [
    makeFinding('Your CLAUDE.md is too long', 'high', 5000),
    makeFinding('Claude is re-reading the same files', 'medium', 3000),
    makeFinding('Shrink bash output limit', 'low', 1000),
  ],
  costRate: 0.00001,
  healthScore: 71,
  healthGrade: 'C',
}

async function collectMetrics(periodData: PeriodData, optimizeResult: OptimizeResult | null) {
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

  recordMetrics(meter, periodData, optimizeResult, [])

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
  it('classifies context_bloat titles', () => {
    expect(classifyWasteDomain(makeFinding('Your CLAUDE.md is too long', 'high'))).toBe('context_bloat')
    expect(classifyWasteDomain(makeFinding('2 MCP servers configured but never used', 'medium'))).toBe('context_bloat')
    expect(classifyWasteDomain(makeFinding('3 custom ghost agents you never use', 'low'))).toBe('context_bloat')
    expect(classifyWasteDomain(makeFinding('2 ghost skills you never use', 'low'))).toBe('context_bloat')
    expect(classifyWasteDomain(makeFinding('5 ghost commands you never use', 'low'))).toBe('context_bloat')
  })

  it('classifies read_waste titles', () => {
    expect(classifyWasteDomain(makeFinding('Claude is reading junk read folders', 'medium'))).toBe('read_waste')
    expect(classifyWasteDomain(makeFinding('Claude is re-reading duplicate read files', 'medium'))).toBe('read_waste')
    expect(classifyWasteDomain(makeFinding('Low read/edit ratio', 'high'))).toBe('read_waste')
    expect(classifyWasteDomain(makeFinding('Low read-to-edit ratio', 'high'))).toBe('read_waste')
  })

  it('classifies cache_waste titles', () => {
    expect(classifyWasteDomain(makeFinding('Session warmup cache is large', 'medium'))).toBe('cache_waste')
  })

  it('classifies config_waste titles', () => {
    expect(classifyWasteDomain(makeFinding('Shrink bash output limit', 'medium'))).toBe('config_waste')
    expect(classifyWasteDomain(makeFinding('Timeout too high', 'low'))).toBe('config_waste')
  })

  it('defaults to other', () => {
    expect(classifyWasteDomain(makeFinding('Something unknown', 'low'))).toBe('other')
  })
})

describe('recordMetrics', () => {
  let metrics: Map<string, Array<{ value: number; attributes: Record<string, unknown> }>>

  beforeEach(async () => {
    metrics = await collectMetrics(samplePeriodData, sampleOptimizeResult)
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

  it('records oneshot rate per category with editTurns > 0', () => {
    const points = metrics.get('codeburn.oneshot.rate')!
    expect(points).toHaveLength(2) // Coding and Debugging, not Exploration
    const coding = points.find(p => p.attributes.activity === 'Coding')!
    expect(coding.value).toBe(18 / 20)
    const debugging = points.find(p => p.attributes.activity === 'Debugging')!
    expect(debugging.value).toBe(5 / 10)
  })

  it('records health penalty by domain', () => {
    const points = metrics.get('codeburn.health.penalty')!
    const contextBloat = points.find(p => p.attributes.domain === 'context_bloat')!
    expect(contextBloat.value).toBe(15) // high=15
    // "Claude is re-reading the same files" -> 'other' (no "duplicate read" in title)
    const other = points.find(p => p.attributes.domain === 'other')!
    expect(other.value).toBe(7) // medium=7
    const configWaste = points.find(p => p.attributes.domain === 'config_waste')!
    expect(configWaste.value).toBe(3) // low=3
  })

  it('records cost per model and total', () => {
    const points = metrics.get('codeburn.cost.usage')!
    const sonnet = points.find(p => p.attributes.model === 'claude-sonnet-4-6')!
    expect(sonnet.value).toBe(10)
    const haiku = points.find(p => p.attributes.model === 'claude-haiku-3.5')!
    expect(haiku.value).toBe(2.5)
    const total = points.find(p => p.attributes.provider === 'all')!
    expect(total.value).toBe(12.5)
  })

  it('records token usage by type', () => {
    const points = metrics.get('codeburn.token.usage')!
    expect(points.find(p => p.attributes.type === 'input')!.value).toBe(80000)
    expect(points.find(p => p.attributes.type === 'output')!.value).toBe(20000)
    expect(points.find(p => p.attributes.type === 'cache_read')!.value).toBe(20000)
    expect(points.find(p => p.attributes.type === 'cache_write')!.value).toBe(5000)
  })

  it('records session and call counts', () => {
    expect(metrics.get('codeburn.session.count')![0].value).toBe(5)
    expect(metrics.get('codeburn.api_call.count')![0].value).toBe(100)
  })

  it('records activity turns per category', () => {
    const points = metrics.get('codeburn.activity.turns')!
    expect(points.find(p => p.attributes.category === 'Coding')!.value).toBe(40)
    expect(points.find(p => p.attributes.category === 'Debugging')!.value).toBe(15)
    expect(points.find(p => p.attributes.category === 'Exploration')!.value).toBe(10)
  })

  it('records optimize findings by impact', () => {
    const points = metrics.get('codeburn.optimize.findings')!
    expect(points.find(p => p.attributes.impact === 'high')!.value).toBe(1)
    expect(points.find(p => p.attributes.impact === 'medium')!.value).toBe(1)
    expect(points.find(p => p.attributes.impact === 'low')!.value).toBe(1)
  })

  it('records total savings tokens', () => {
    expect(metrics.get('codeburn.optimize.savings_tokens')![0].value).toBe(9000)
  })
})

describe('recordMetrics with empty data', () => {
  it('handles zero PeriodData', async () => {
    const emptyPeriod: PeriodData = {
      label: 'empty',
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
    const metrics = await collectMetrics(emptyPeriod, null)
    // Gauges still emit with zero values
    expect(metrics.get('codeburn.health.score')![0].value).toBe(100)
    expect(metrics.get('codeburn.health.score')![0].attributes.grade).toBe('A')
    expect(metrics.get('codeburn.cache_hit.percent')![0].value).toBe(0)
    // ObservableCounters with zero values still emit data points
    expect(metrics.get('codeburn.session.count')![0].value).toBe(0)
    expect(metrics.get('codeburn.optimize.savings_tokens')![0].value).toBe(0)
  })

  it('handles null OptimizeResult', async () => {
    const metrics = await collectMetrics(samplePeriodData, null)
    expect(metrics.get('codeburn.health.score')![0].value).toBe(100)
    expect(metrics.get('codeburn.health.score')![0].attributes.grade).toBe('A')
    // With null OptimizeResult, findings counters observe 0 → still emit
    expect(metrics.get('codeburn.optimize.findings')!.every(p => p.value === 0)).toBe(true)
    expect(metrics.get('codeburn.optimize.savings_tokens')![0].value).toBe(0)
  })
})

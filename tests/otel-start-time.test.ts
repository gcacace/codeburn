import { describe, it, expect } from 'vitest'
import { MeterProvider, AggregationTemporality, Aggregation, type ResourceMetrics, type PushMetricExporter } from '@opentelemetry/sdk-metrics'
import type { HrTime } from '@opentelemetry/api'
import { ExportResultCode, type ExportResult, millisToHrTime } from '@opentelemetry/core'
import { overrideStartTimes, StartTimeOverrideExporter } from '../src/otel-start-time.js'
import { recordMetrics, emptyOtelSnapshot, type OtelSnapshot } from '../src/otel-metrics.js'

const sampleSnapshot: OtelSnapshot = {
  ...emptyOtelSnapshot(),
  cost: 10,
  calls: 50,
  sessions: 3,
  inputTokens: 1000,
  outputTokens: 500,
  categories: [{ name: 'Coding', cost: 10, savingsUSD: 0, turns: 20, oneShotRate: 0.9 }],
  models: [{ name: 'claude-sonnet-4-6', cost: 10, calls: 50, savingsUSD: 0, estimatedCostUSD: 0 }],
  providers: [{ name: 'claude', cost: 10 }],
  optimize: { healthScore: 90, healthGrade: 'A', costRate: 0.00001, findings: [], modelRecommendations: [] },
}

// Collect the SDK's in-memory ResourceMetrics (pre-serialization), where data
// points still carry HrTime tuples we can compare against.
async function collectResourceMetrics(snapshot: OtelSnapshot): Promise<ResourceMetrics> {
  const { MetricReader } = await import('@opentelemetry/sdk-metrics')
  class TestReader extends MetricReader {
    protected onForceFlush(): Promise<void> { return Promise.resolve() }
    protected onShutdown(): Promise<void> { return Promise.resolve() }
    selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE }
  }
  const reader = new TestReader()
  const provider = new MeterProvider({ readers: [reader] })
  recordMetrics(provider.getMeter('test'), snapshot)
  const { resourceMetrics } = await reader.collect()
  await provider.shutdown()
  return resourceMetrics
}

function allStartTimes(metrics: ResourceMetrics): HrTime[] {
  const out: HrTime[] = []
  for (const sm of metrics.scopeMetrics) for (const m of sm.metrics) for (const dp of m.dataPoints) {
    out.push(dp.startTime)
  }
  return out
}

describe('overrideStartTimes', () => {
  it('pins every data point startTime to the anchor', async () => {
    const metrics = await collectResourceMetrics(sampleSnapshot)
    const before = allStartTimes(metrics)
    expect(before.length).toBeGreaterThan(0)

    const anchor = millisToHrTime(new Date(2026, 0, 15).getTime())
    overrideStartTimes(metrics, anchor)

    const after = allStartTimes(metrics)
    expect(after.length).toBe(before.length)
    // Every point now equals the anchor tuple.
    for (const st of after) {
      expect(st[0]).toBe(anchor[0])
      expect(st[1]).toBe(anchor[1])
    }
  })

  it('leaves endTime untouched', async () => {
    const metrics = await collectResourceMetrics(sampleSnapshot)
    const endBefore = metrics.scopeMetrics[0].metrics[0].dataPoints[0].endTime
    overrideStartTimes(metrics, millisToHrTime(0))
    const endAfter = metrics.scopeMetrics[0].metrics[0].dataPoints[0].endTime
    expect(endAfter).toEqual(endBefore)
  })

  it('is a no-op on an empty-snapshot collection without throwing', async () => {
    const metrics = await collectResourceMetrics(emptyOtelSnapshot())
    expect(() => overrideStartTimes(metrics, millisToHrTime(0))).not.toThrow()
  })
})

describe('StartTimeOverrideExporter', () => {
  // A stub inner exporter that records what it received and how it was called.
  class StubExporter implements PushMetricExporter {
    exported: ResourceMetrics | null = null
    forceFlushed = false
    shutdownCalled = false
    export(metrics: ResourceMetrics, cb: (r: ExportResult) => void): void {
      this.exported = metrics
      cb({ code: ExportResultCode.SUCCESS })
    }
    forceFlush(): Promise<void> { this.forceFlushed = true; return Promise.resolve() }
    shutdown(): Promise<void> { this.shutdownCalled = true; return Promise.resolve() }
    selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE }
    selectAggregation() { return Aggregation.Default() }
  }

  it('overrides start times then delegates export to the inner exporter', async () => {
    const metrics = await collectResourceMetrics(sampleSnapshot)
    const inner = new StubExporter()
    const anchor = millisToHrTime(new Date(2026, 0, 15).getTime())
    const wrapper = new StartTimeOverrideExporter(inner, anchor)

    let result: ExportResult | undefined
    wrapper.export(metrics, (r) => { result = r })

    expect(result?.code).toBe(ExportResultCode.SUCCESS)
    expect(inner.exported).toBe(metrics) // same object, delegated through
    for (const st of allStartTimes(inner.exported!)) {
      expect(st[0]).toBe(anchor[0])
      expect(st[1]).toBe(anchor[1])
    }
  })

  it('delegates forceFlush and shutdown to the inner exporter', async () => {
    const inner = new StubExporter()
    const wrapper = new StartTimeOverrideExporter(inner, millisToHrTime(0))
    await wrapper.forceFlush()
    await wrapper.shutdown()
    expect(inner.forceFlushed).toBe(true)
    expect(inner.shutdownCalled).toBe(true)
  })

  it('delegates temporality selection to the inner exporter', () => {
    const inner = new StubExporter()
    const wrapper = new StartTimeOverrideExporter(inner, millisToHrTime(0))
    // InstrumentType arg is unused by the stub; cast a placeholder.
    expect(wrapper.selectAggregationTemporality('COUNTER' as never)).toBe(AggregationTemporality.CUMULATIVE)
  })
})

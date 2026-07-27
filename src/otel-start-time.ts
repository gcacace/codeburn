import type { HrTime } from '@opentelemetry/api'
import { AggregationTemporality, Aggregation } from '@opentelemetry/sdk-metrics'
import type {
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import type { ExportResult } from '@opentelemetry/core'

// Overwrite every data point's `startTime` with a fixed anchor, in place.
//
// Why: `emitOtelMetrics` builds a fresh MeterProvider per invocation and tears
// it down, so the SDK stamps each cumulative data point's start time at
// provider-creation time — a NEW start time on every ~30s emit. Backends that
// convert cumulative→delta by trusting `start_time` (OTel Collector Prometheus
// exporter, AMP, CloudWatch) then see the accumulation window churn, inducing
// spurious intra-day resets. Pinning every point to today's local midnight (the
// window the values actually cover — they are "today's running total") makes the
// series a clean per-day counter: no intra-day churn, and the day rollover is a
// single legitimate reset the backend detects from the changing start time.
//
// The SDK types mark `startTime` readonly, but at runtime the data points are
// plain mutable object literals (created in SumAggregator.toMetricData with no
// freeze), and both our exporters serialize the live object verbatim — so this
// mutation deterministically sets the emitted `startTimeUnixNano`. `endTime`
// (the collection time / "now") is left untouched. Gauges get stamped too, which
// is harmless: backends ignore a gauge's start time.
export function overrideStartTimes(metrics: ResourceMetrics, anchor: HrTime): void {
  for (const scopeMetric of metrics.scopeMetrics) {
    for (const metric of scopeMetric.metrics) {
      for (const dataPoint of metric.dataPoints) {
        // Cast past the compile-time `readonly`; the runtime object is mutable.
        ;(dataPoint as { startTime: HrTime }).startTime = anchor
      }
    }
  }
}

// A PushMetricExporter decorator that pins start times to `anchor` before
// delegating to the wrapped exporter. Wrapping at the exporter layer covers both
// the standard OTLP exporter and the custom SigV4 exporter with one code path,
// since each serializes the ResourceMetrics it is handed.
export class StartTimeOverrideExporter implements PushMetricExporter {
  constructor(
    private readonly inner: PushMetricExporter,
    private readonly anchor: HrTime,
  ) {}

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    overrideStartTimes(metrics, this.anchor)
    this.inner.export(metrics, resultCallback)
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    // Both our inner exporters define this (standard prefers CUMULATIVE, SigV4
    // hard-codes it). Fall back to CUMULATIVE if an inner ever omits it, so the
    // reader still gets the temporality these metrics are designed for.
    return this.inner.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE
  }

  selectAggregation(instrumentType: InstrumentType): Aggregation {
    return this.inner.selectAggregation?.(instrumentType) ?? Aggregation.Default()
  }
}

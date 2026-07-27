import { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { MeterProvider, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { millisToHrTime } from '@opentelemetry/core'
import { hostname } from 'os'
import type { OtelConfig } from './config.js'
import { recordMetrics, type OtelSnapshot } from './otel-metrics.js'
import { resolveHeaders } from './otel-headers.js'
import { StartTimeOverrideExporter } from './otel-start-time.js'
import { getDeviceId } from './sync/otlp.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export function buildResource(config: OtelConfig): Resource {
  return new Resource({
    [ATTR_SERVICE_NAME]: 'codeburn',
    [ATTR_SERVICE_VERSION]: version,
    // Pseudonymous per-machine identity so an org can drill into a single
    // developer/host before configuring user.email. device_id is a salted
    // hash of host:user (never the raw values); host.name follows OTel's
    // `host.name` semantic convention. User-configured resourceAttributes are
    // spread LAST so an org can override or suppress either of these.
    'codeburn.device_id': getDeviceId(),
    'host.name': hostname(),
    ...config.resourceAttributes,
  })
}

export function createStandardExporter(config: OtelConfig, headers: Record<string, string>): OTLPMetricExporter {
  return new OTLPMetricExporter({
    url: config.endpoint,
    headers,
    temporalityPreference: AggregationTemporality.CUMULATIVE,
  })
}

export async function emitOtelMetrics(
  otelConfig: OtelConfig,
  snapshot: OtelSnapshot,
  // Start of the local day the snapshot covers. Every cumulative data point's
  // startTimeUnixNano is pinned to this, so the metrics are a clean per-day
  // counter instead of one whose start time churns on every ~30s emit. Passed
  // in (rather than recomputed here) so it always matches the exact day window
  // the snapshot was built from, even across a midnight tick.
  dayStart: Date,
): Promise<void> {
  try {
    const headers = await resolveHeaders(otelConfig)
    const resource = buildResource(otelConfig)

    let exporter
    if (otelConfig.sigv4) {
      const { createSigV4Exporter } = await import('./otel-sigv4.js')
      exporter = createSigV4Exporter({
        endpoint: otelConfig.endpoint,
        region: otelConfig.sigv4.region,
        service: otelConfig.sigv4.service,
        profile: otelConfig.sigv4.profile,
      })
    } else {
      exporter = createStandardExporter(otelConfig, headers)
    }

    // Pin start times to local midnight of the snapshot's day, covering both the
    // standard and SigV4 exporters with one wrap.
    exporter = new StartTimeOverrideExporter(exporter, millisToHrTime(dayStart.getTime()))

    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 1000,
    })
    const meterProvider = new MeterProvider({ resource, readers: [reader] })
    const meter = meterProvider.getMeter('com.agentseal.codeburn')

    recordMetrics(meter, snapshot)

    await meterProvider.forceFlush()
    await meterProvider.shutdown()
  } catch (err) {
    if (process.env['CODEBURN_VERBOSE']) {
      process.stderr.write(`[codeburn] otel emit failed: ${(err as Error).message}\n`)
    }
  }
}

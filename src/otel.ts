import { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { MeterProvider, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import type { OtelConfig } from './config.js'
import type { PeriodData } from './menubar-json.js'
import type { OptimizeResult } from './optimize.js'
import type { ProjectSummary } from './types.js'
import { recordMetrics } from './otel-metrics.js'
import { resolveHeaders } from './otel-headers.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export function buildResource(config: OtelConfig): Resource {
  return new Resource({
    [ATTR_SERVICE_NAME]: 'codeburn',
    [ATTR_SERVICE_VERSION]: version,
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
  periodData: PeriodData,
  optimizeResult: OptimizeResult | null,
  projects: ProjectSummary[],
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

    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 1000,
    })
    const meterProvider = new MeterProvider({ resource, readers: [reader] })
    const meter = meterProvider.getMeter('com.agentseal.codeburn')

    recordMetrics(meter, periodData, optimizeResult, projects)

    await meterProvider.forceFlush()
    await meterProvider.shutdown()
  } catch (err) {
    if (process.env['CODEBURN_VERBOSE']) {
      process.stderr.write(`[codeburn] otel emit failed: ${(err as Error).message}\n`)
    }
  }
}

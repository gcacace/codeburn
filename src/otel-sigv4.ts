import { AggregationTemporality, Aggregation, type PushMetricExporter, type ResourceMetrics, type InstrumentType } from '@opentelemetry/sdk-metrics'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer'

export type SigV4ExporterConfig = {
  endpoint: string
  region: string
  service: string
  profile?: string
}

export class SigV4OtlpExporter implements PushMetricExporter {
  private readonly config: SigV4ExporterConfig

  constructor(config: SigV4ExporterConfig) {
    this.config = config
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this._export(metrics).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      () => resultCallback({ code: ExportResultCode.FAILED }),
    )
  }

  private async _export(metrics: ResourceMetrics): Promise<void> {
    // Cast needed: otlp-transformer bundles a newer sdk-metrics internally
    const body = JsonMetricsSerializer.serializeRequest(metrics as never)
    if (!body) throw new Error('Serialization returned undefined')

    const { SignatureV4 } = await import('@aws-sdk/signature-v4')
    const { HttpRequest } = await import('@smithy/protocol-http')
    const { Hash } = await import('@smithy/hash-node')
    const credProviders = await import('@aws-sdk/credential-providers')

    const url = new URL(this.config.endpoint)
    const credentials = this.config.profile
      ? credProviders.fromIni({ profile: this.config.profile })
      : credProviders.fromNodeProviderChain()

    const signer = new SignatureV4({
      credentials,
      region: this.config.region,
      service: this.config.service,
      sha256: Hash.bind(null, 'sha256'),
    })

    const request = new HttpRequest({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        host: url.hostname,
      },
      body: Buffer.from(body),
    })

    const signed = await signer.sign(request)

    const res = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body: Buffer.from(body),
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  selectAggregationTemporality(_instrumentType: InstrumentType): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE
  }

  selectAggregation(_instrumentType: InstrumentType): Aggregation {
    return Aggregation.Default()
  }
}

export function createSigV4Exporter(config: SigV4ExporterConfig): SigV4OtlpExporter {
  return new SigV4OtlpExporter(config)
}

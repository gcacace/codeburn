import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AggregationTemporality, InstrumentType } from '@opentelemetry/sdk-metrics'
import { ExportResultCode } from '@opentelemetry/core'

// Mock AWS SDK modules
const mockSign = vi.fn()
const mockFromIni = vi.fn()
const mockFromNodeProviderChain = vi.fn()

vi.mock('@aws-sdk/signature-v4', () => ({
  SignatureV4: vi.fn().mockImplementation(() => ({ sign: mockSign })),
}))

vi.mock('@smithy/protocol-http', () => ({
  HttpRequest: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({ ...opts })),
}))

vi.mock('@smithy/hash-node', () => ({
  Hash: vi.fn(),
}))

vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: mockFromIni,
  fromNodeProviderChain: mockFromNodeProviderChain,
}))

vi.mock('@opentelemetry/otlp-transformer', () => ({
  JsonMetricsSerializer: {
    serializeRequest: vi.fn().mockReturnValue(new Uint8Array([123, 125])),
  },
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { SigV4OtlpExporter, createSigV4Exporter } from '../src/otel-sigv4.js'

const baseConfig = {
  endpoint: 'https://xray.us-east-1.amazonaws.com/v1/metrics',
  region: 'us-east-1',
  service: 'xray',
}

describe('SigV4OtlpExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSign.mockResolvedValue({
      headers: { Authorization: 'AWS4-HMAC-SHA256 ...', 'X-Amz-Date': '20260426T000000Z', host: 'xray.us-east-1.amazonaws.com', 'Content-Type': 'application/json' },
    })
    mockFromIni.mockReturnValue(vi.fn())
    mockFromNodeProviderChain.mockReturnValue(vi.fn())
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
  })

  it('selectAggregationTemporality returns CUMULATIVE', () => {
    const exporter = new SigV4OtlpExporter(baseConfig)
    expect(exporter.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(AggregationTemporality.CUMULATIVE)
  })

  it('export produces a signed request with Authorization and X-Amz-Date headers', async () => {
    const exporter = new SigV4OtlpExporter(baseConfig)
    const result = await new Promise<ExportResultCode>((resolve) => {
      exporter.export({} as never, (r) => resolve(r.code))
    })
    expect(result).toBe(ExportResultCode.SUCCESS)
    expect(mockSign).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledOnce()
    const [, fetchOpts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(fetchOpts.headers).toHaveProperty('Authorization')
    expect(fetchOpts.headers).toHaveProperty('X-Amz-Date')
  })

  it('uses fromIni when profile is set', async () => {
    const exporter = new SigV4OtlpExporter({ ...baseConfig, profile: 'my-profile' })
    await new Promise<void>((resolve) => {
      exporter.export({} as never, () => resolve())
    })
    expect(mockFromIni).toHaveBeenCalledWith({ profile: 'my-profile' })
    expect(mockFromNodeProviderChain).not.toHaveBeenCalled()
  })

  it('uses fromNodeProviderChain when no profile', async () => {
    const exporter = new SigV4OtlpExporter(baseConfig)
    await new Promise<void>((resolve) => {
      exporter.export({} as never, () => resolve())
    })
    expect(mockFromNodeProviderChain).toHaveBeenCalled()
    expect(mockFromIni).not.toHaveBeenCalled()
  })

  it('calls resultCallback with FAILED on credential failure, never throws', async () => {
    mockSign.mockRejectedValue(new Error('credential failure'))
    const exporter = new SigV4OtlpExporter(baseConfig)
    const result = await new Promise<ExportResultCode>((resolve) => {
      exporter.export({} as never, (r) => resolve(r.code))
    })
    expect(result).toBe(ExportResultCode.FAILED)
  })

  it('calls resultCallback with FAILED on network error, never throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const exporter = new SigV4OtlpExporter(baseConfig)
    const result = await new Promise<ExportResultCode>((resolve) => {
      exporter.export({} as never, (r) => resolve(r.code))
    })
    expect(result).toBe(ExportResultCode.FAILED)
  })

  it('calls resultCallback with FAILED on 403 response, never throws', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 })
    const exporter = new SigV4OtlpExporter(baseConfig)
    const result = await new Promise<ExportResultCode>((resolve) => {
      exporter.export({} as never, (r) => resolve(r.code))
    })
    expect(result).toBe(ExportResultCode.FAILED)
  })

  it('createSigV4Exporter factory returns an exporter instance', () => {
    const exporter = createSigV4Exporter(baseConfig)
    expect(exporter).toBeInstanceOf(SigV4OtlpExporter)
  })

  it('forceFlush and shutdown resolve', async () => {
    const exporter = new SigV4OtlpExporter(baseConfig)
    await expect(exporter.forceFlush()).resolves.toBeUndefined()
    await expect(exporter.shutdown()).resolves.toBeUndefined()
  })
})

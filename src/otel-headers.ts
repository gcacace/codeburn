import { execFile } from 'node:child_process'
import type { OtelConfig } from './config.js'

function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => typeof val === 'string')
}

export class DynamicHeadersHelper {
  private cachedHeaders: Record<string, string> | null = null
  private cachedAt = 0
  private scriptPath: string
  private refreshIntervalMs: number

  constructor(scriptPath: string, refreshIntervalMs: number = 1_740_000) {
    this.scriptPath = scriptPath
    this.refreshIntervalMs = refreshIntervalMs
  }

  async getHeaders(): Promise<Record<string, string>> {
    if (this.cachedHeaders && Date.now() - this.cachedAt < this.refreshIntervalMs) {
      return this.cachedHeaders
    }

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(this.scriptPath, { timeout: 10_000 }, (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout)
        })
      })

      const parsed: unknown = JSON.parse(stdout)
      if (!isStringRecord(parsed)) throw new Error('Script output is not a Record<string, string>')

      this.cachedHeaders = parsed
      this.cachedAt = Date.now()
      return this.cachedHeaders
    } catch (err) {
      process.stderr.write(`[codeburn] headers helper failed: ${(err as Error).message}\n`)
      return this.cachedHeaders ?? {}
    }
  }
}

const helpers = new Map<string, DynamicHeadersHelper>()

export async function resolveHeaders(otelConfig: OtelConfig): Promise<Record<string, string>> {
  const staticHeaders = otelConfig.headers ?? {}

  if (!otelConfig.headersHelper) return staticHeaders

  let helper = helpers.get(otelConfig.headersHelper)
  if (!helper) {
    helper = new DynamicHeadersHelper(otelConfig.headersHelper, otelConfig.headersHelperIntervalMs)
    helpers.set(otelConfig.headersHelper, helper)
  }

  const dynamic = await helper.getHeaders()
  return { ...staticHeaders, ...dynamic }
}

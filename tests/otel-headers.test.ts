import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { DynamicHeadersHelper, resolveHeaders } from '../src/otel-headers.js'
import type { OtelConfig } from '../src/config.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-headers-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function makeScript(name: string, body: string): Promise<string> {
  const p = join(tmpDir, name)
  await writeFile(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return p
}

describe('DynamicHeadersHelper', () => {
  it('returns headers from a valid script', async () => {
    const script = await makeScript('ok.sh', 'echo \'{"Authorization":"Bearer test"}\'')
    const helper = new DynamicHeadersHelper(script)
    const headers = await helper.getHeaders()
    expect(headers).toEqual({ Authorization: 'Bearer test' })
  })

  it('returns cached headers without re-execution within interval', async () => {
    let calls = 0
    const script = await makeScript('counter.sh', `echo '{"n":"'$(($(date +%s%N)))'"}' `)
    const helper = new DynamicHeadersHelper(script, 60_000)

    const h1 = await helper.getHeaders()
    const h2 = await helper.getHeaders()
    // Same object reference means cache was used
    expect(h1).toBe(h2)
  })

  it('re-executes when cache is stale', async () => {
    const script = await makeScript('ts.sh', 'echo \'{"v":"1"}\'')
    const helper = new DynamicHeadersHelper(script, 1) // 1ms interval

    const h1 = await helper.getHeaders()
    // Wait for cache to expire
    await new Promise(r => setTimeout(r, 10))
    const h2 = await helper.getHeaders()
    // Both valid but not the same reference (re-executed)
    expect(h1).not.toBe(h2)
    expect(h2).toEqual({ v: '1' })
  })

  it('returns empty headers and warns on missing script', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const helper = new DynamicHeadersHelper('/nonexistent/script.sh')
    const headers = await helper.getHeaders()
    expect(headers).toEqual({})
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('headers helper failed'))
    stderrSpy.mockRestore()
  })

  it('falls back on invalid JSON output', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const script = await makeScript('bad.sh', 'echo "not json"')
    const helper = new DynamicHeadersHelper(script)
    const headers = await helper.getHeaders()
    expect(headers).toEqual({})
    expect(stderrSpy).toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it('falls back on non-zero exit', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const script = await makeScript('fail.sh', 'exit 1')
    const helper = new DynamicHeadersHelper(script)
    const headers = await helper.getHeaders()
    expect(headers).toEqual({})
    expect(stderrSpy).toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it('returns last-known-good headers after failure', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const script = await makeScript('flip.sh', 'echo \'{"token":"abc"}\'')
    const helper = new DynamicHeadersHelper(script, 1) // 1ms so cache always stale

    const good = await helper.getHeaders()
    expect(good).toEqual({ token: 'abc' })

    // Overwrite script to fail
    await writeFile(script, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await new Promise(r => setTimeout(r, 10))

    const fallback = await helper.getHeaders()
    expect(fallback).toEqual({ token: 'abc' })
    expect(stderrSpy).toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})

describe('resolveHeaders', () => {
  it('returns static headers when no headersHelper', async () => {
    const config: OtelConfig = { enabled: true, endpoint: 'http://localhost', headers: { 'x-key': 'val' } }
    expect(await resolveHeaders(config)).toEqual({ 'x-key': 'val' })
  })

  it('returns empty when no headers and no helper', async () => {
    const config: OtelConfig = { enabled: true, endpoint: 'http://localhost' }
    expect(await resolveHeaders(config)).toEqual({})
  })

  it('merges static and dynamic headers with dynamic taking precedence', async () => {
    const script = await makeScript('merge.sh', 'echo \'{"Authorization":"dynamic","extra":"dyn"}\'')
    const config: OtelConfig = {
      enabled: true,
      endpoint: 'http://localhost',
      headers: { Authorization: 'static', 'x-static': 'keep' },
      headersHelper: script,
    }
    const result = await resolveHeaders(config)
    expect(result).toEqual({ Authorization: 'dynamic', 'x-static': 'keep', extra: 'dyn' })
  })
})

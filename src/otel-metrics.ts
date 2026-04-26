import type { Meter } from '@opentelemetry/api'
import type { PeriodData } from './menubar-json.js'
import type { OptimizeResult, WasteFinding, Impact } from './optimize.js'
import type { ProjectSummary } from './types.js'

const HEALTH_WEIGHTS: Record<Impact, number> = { high: 15, medium: 7, low: 3 }

const WASTE_DOMAIN_RULES: Array<{ domain: string; patterns: RegExp }> = [
  { domain: 'context_bloat', patterns: /claude\.md|mcp|ghost agent|ghost skill|ghost command/i },
  { domain: 'read_waste', patterns: /junk read|duplicate read|read\/edit|read-to-edit/i },
  { domain: 'cache_waste', patterns: /cache/i },
  { domain: 'config_waste', patterns: /bash|timeout/i },
]

export function classifyWasteDomain(finding: WasteFinding): string {
  for (const { domain, patterns } of WASTE_DOMAIN_RULES) {
    if (patterns.test(finding.title)) return domain
  }
  return 'other'
}

export function recordMetrics(
  meter: Meter,
  periodData: PeriodData,
  optimizeResult: OptimizeResult | null,
  _projects: ProjectSummary[],
): void {
  const findings = optimizeResult?.findings ?? []

  // --- Gauges: point-in-time ratios/scores (no temporality) ---

  meter.createGauge('codeburn.health.score')
    .record(optimizeResult?.healthScore ?? 100, { grade: optimizeResult?.healthGrade ?? 'A' })

  const denom = periodData.inputTokens + periodData.cacheReadTokens
  const cacheHit = denom > 0 ? (periodData.cacheReadTokens / denom) * 100 : 0
  meter.createGauge('codeburn.cache_hit.percent').record(cacheHit)

  const oneShotGauge = meter.createGauge('codeburn.oneshot.rate')
  for (const cat of periodData.categories) {
    if (cat.editTurns > 0) {
      oneShotGauge.record(cat.oneShotTurns / cat.editTurns, { activity: cat.name })
    }
  }

  const domainPenalties = new Map<string, number>()
  for (const f of findings) {
    const domain = classifyWasteDomain(f)
    domainPenalties.set(domain, (domainPenalties.get(domain) ?? 0) + HEALTH_WEIGHTS[f.impact])
  }
  const penaltyGauge = meter.createGauge('codeburn.health.penalty')
  for (const [domain, penalty] of domainPenalties) {
    penaltyGauge.record(penalty, { domain })
  }

  // --- ObservableCounters: cumulative accumulating quantities ---
  // These report today's running total. The backend interprets them as
  // cumulative counters that reset daily at midnight.

  const costCounter = meter.createObservableCounter('codeburn.cost.usage')
  costCounter.addCallback((obs) => {
    for (const model of periodData.models) {
      obs.observe(model.cost, { model: model.name })
    }
    obs.observe(periodData.cost, { provider: 'all' })
  })

  const tokenCounter = meter.createObservableCounter('codeburn.token.usage')
  tokenCounter.addCallback((obs) => {
    obs.observe(periodData.inputTokens, { type: 'input' })
    obs.observe(periodData.outputTokens, { type: 'output' })
    obs.observe(periodData.cacheReadTokens, { type: 'cache_read' })
    obs.observe(periodData.cacheWriteTokens, { type: 'cache_write' })
  })

  const sessionCounter = meter.createObservableCounter('codeburn.session.count')
  sessionCounter.addCallback((obs) => { obs.observe(periodData.sessions) })

  const callCounter = meter.createObservableCounter('codeburn.api_call.count')
  callCounter.addCallback((obs) => { obs.observe(periodData.calls) })

  const turnsCounter = meter.createObservableCounter('codeburn.activity.turns')
  turnsCounter.addCallback((obs) => {
    for (const cat of periodData.categories) {
      obs.observe(cat.turns, { category: cat.name })
    }
  })

  const impactCounts: Record<Impact, number> = { high: 0, medium: 0, low: 0 }
  for (const f of findings) impactCounts[f.impact]++
  const findingsCounter = meter.createObservableCounter('codeburn.optimize.findings')
  findingsCounter.addCallback((obs) => {
    for (const [impact, count] of Object.entries(impactCounts)) {
      obs.observe(count, { impact })
    }
  })

  const totalSavings = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const savingsCounter = meter.createObservableCounter('codeburn.optimize.savings_tokens')
  savingsCounter.addCallback((obs) => { obs.observe(totalSavings) })
}

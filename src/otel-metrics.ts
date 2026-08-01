import type { Meter } from '@opentelemetry/api'
import type { MenubarPayload } from './menubar-json.js'
import type { OptimizeResult, FindingId, Impact } from './optimize.js'
import type { ProjectSummary } from './types.js'

const HEALTH_WEIGHTS: Record<Impact, number> = { high: 15, medium: 7, low: 3 }

// Waste domains group the ~19 optimize findings into a handful of buckets a
// dashboard can chart. The domain rides on the `codeburn.health.penalty`
// metric's `domain` attribute so an org can see WHICH KIND of waste is
// dragging its health score down (context bloat vs read waste vs …).
export type WasteDomain =
  | 'context_bloat'
  | 'read_waste'
  | 'cache_waste'
  | 'config_waste'
  | 'mcp_waste'
  | 'session_waste'
  | 'retry_waste'
  | 'other'

// Map the STABLE machine-readable finding id to a domain. Preferred over
// regex-matching the human-facing title (fragile: titles get reworded, and a
// broad /cache/i would swallow unrelated findings). Every id in the FindingId
// union should appear here; a missing id falls back to 'other' (see
// classifyWasteDomain), which keeps this forward-compatible if new findings
// land before this map is updated.
const FINDING_ID_DOMAIN: Record<FindingId, WasteDomain> = {
  'claude-md-too-long': 'context_bloat',
  'unused-agents': 'context_bloat',
  'unused-skills': 'context_bloat',
  'unused-commands': 'context_bloat',
  'read-edit-ratio': 'read_waste',
  'build-folder-reads': 'read_waste',
  'redundant-rereads': 'read_waste',
  'warmup-heavy': 'cache_waste',
  'bash-output-cap': 'config_waste',
  'unused-mcp': 'mcp_waste',
  'mcp-low-coverage': 'mcp_waste',
  'mcp-project-scope': 'mcp_waste',
  'mcp-deferral-off': 'mcp_waste',
  'mcp-alwaysload-hygiene': 'mcp_waste',
  'mcp-defer-threshold': 'mcp_waste',
  'low-worth-sessions': 'session_waste',
  'context-heavy-sessions': 'session_waste',
  'cost-outliers': 'session_waste',
  'retry-heavy-capabilities': 'retry_waste',
}

export function classifyWasteDomain(finding: { id: FindingId }): WasteDomain {
  return FINDING_ID_DOMAIN[finding.id] ?? 'other'
}

// ---------------------------------------------------------------------------
// OtelSnapshot: the single, rich input to recordMetrics.
//
// Assembled by buildOtelSnapshot from the SAME MenubarPayload the menubar
// already computes (retryTax / routingWaste / localModelSavings / providers /
// modelEfficiency are all there), plus an OptimizeResult and a couple of
// figures only the surviving-session parse carries (reasoning tokens,
// subscription-proxied cost). This keeps emission decoupled from how the data
// was produced and gives every instrument a flat, populated shape to read.
// ---------------------------------------------------------------------------
export type OtelSnapshot = {
  // Headline period totals.
  cost: number
  estimatedCostUSD: number
  proxiedCostUSD: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  codexCredits: number
  /// Share (0-1) of cost-bearing calls that resolved a price; null when not
  /// computable (must never render as 100%).
  pricingCoverage: number | null
  /// Fraction (0-1) of edit turns that self-corrected; null when no edit turns.
  correctionRate: number | null

  // Per-dimension spend/activity. `oneShotRate` is null when the activity had
  // no edit turns (nothing to score).
  categories: Array<{ name: string; cost: number; savingsUSD: number; turns: number; oneShotRate: number | null }>
  models: Array<{ name: string; cost: number; calls: number; savingsUSD: number; estimatedCostUSD: number }>
  providers: Array<{ name: string; cost: number }>

  // Efficiency + waste (already capped upstream to top-N).
  modelEfficiency: Array<{ name: string; costPerEdit: number | null; oneShotRate: number | null }>
  retryTax: {
    totalUSD: number
    byModel: Array<{ name: string; taxUSD: number; retriesPerEdit: number | null }>
  }
  routingWaste: {
    totalSavingsUSD: number
    baselineModel: string
    baselineCostPerEdit: number
    byModel: Array<{ name: string; savingsUSD: number }>
  }
  localModelSavings: {
    totalUSD: number
    byModel: Array<{ name: string; savingsUSD: number }>
    byProvider: Array<{ name: string; savingsUSD: number }>
  }

  // Optimize scan (null when the scan was skipped on this path).
  optimize: {
    healthScore: number
    healthGrade: string
    costRate: number
    findings: Array<{ id: FindingId; impact: Impact; tokensSaved: number; trend?: string }>
    modelRecommendations: Array<{ fromModel: string; toModel: string; savingsPct: number }>
  } | null

  // Top-N usage breakdowns (inherited caps: top-10 each, straight off the
  // menubar payload). tool/mcp are count-only — there is no per-tool cost or
  // token attribution in the model (many tools share one API call's cost) — so
  // those emit call counts only. skill/subagent additionally carry attributed
  // cost. None of these carry a reliable grand total (they are top-N slices),
  // so recordMetrics emits no `provider:'all'` point for them.
  tools: Array<{ name: string; calls: number }>
  mcpServers: Array<{ name: string; calls: number }>
  skills: Array<{ name: string; turns: number; cost: number }>
  subagents: Array<{ name: string; calls: number; cost: number }>
}

/// Sum the subscription-proxied cost and reasoning tokens the MenubarPayload
/// does not carry. Both are surviving-session concepts, so they come straight
/// off the live ProjectSummary parse.
function proxiedAndReasoning(projects: ProjectSummary[]): { proxiedCostUSD: number; reasoningTokens: number } {
  let proxiedCostUSD = 0
  let reasoningTokens = 0
  for (const p of projects) {
    proxiedCostUSD += p.totalProxiedCostUSD ?? 0
    for (const s of p.sessions) reasoningTokens += s.totalReasoningTokens ?? 0
  }
  return { proxiedCostUSD, reasoningTokens }
}

/// Build the rich snapshot from the menubar-grade payload `current` block, the
/// optimize scan, and the live projects. Reuses every figure the menubar
/// already computed — no re-aggregation here.
export function buildOtelSnapshot(
  current: MenubarPayload['current'],
  optimize: OptimizeResult | null,
  projects: ProjectSummary[],
): OtelSnapshot {
  const { proxiedCostUSD, reasoningTokens } = proxiedAndReasoning(projects)
  return {
    cost: current.cost,
    estimatedCostUSD: current.estimatedCostUSD ?? 0,
    proxiedCostUSD,
    calls: current.calls,
    sessions: current.sessions,
    inputTokens: current.inputTokens,
    outputTokens: current.outputTokens,
    reasoningTokens,
    cacheReadTokens: current.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens,
    codexCredits: current.codexCredits ?? 0,
    pricingCoverage: current.pricingCoverage,
    correctionRate: current.workflow?.correctionRate ?? null,
    categories: current.topActivities.map(a => ({
      name: a.name,
      cost: a.cost,
      savingsUSD: a.savingsUSD,
      turns: a.turns,
      oneShotRate: a.oneShotRate,
    })),
    models: current.topModels.map(m => ({
      name: m.name,
      cost: m.cost,
      calls: m.calls,
      savingsUSD: m.savingsUSD,
      estimatedCostUSD: m.estimatedCostUSD ?? 0,
    })),
    providers: current.providerDetails.map(p => ({ name: p.id, cost: p.cost })),
    modelEfficiency: current.modelEfficiency.map(m => ({
      name: m.name,
      costPerEdit: m.costPerEdit,
      oneShotRate: m.oneShotRate,
    })),
    retryTax: {
      totalUSD: current.retryTax.totalUSD,
      byModel: current.retryTax.byModel.map(m => ({ name: m.name, taxUSD: m.taxUSD, retriesPerEdit: m.retriesPerEdit })),
    },
    routingWaste: {
      totalSavingsUSD: current.routingWaste.totalSavingsUSD,
      baselineModel: current.routingWaste.baselineModel,
      baselineCostPerEdit: current.routingWaste.baselineCostPerEdit,
      byModel: current.routingWaste.byModel.map(m => ({ name: m.name, savingsUSD: m.savingsUSD })),
    },
    localModelSavings: {
      totalUSD: current.localModelSavings.totalUSD,
      byModel: current.localModelSavings.byModel.map(m => ({ name: m.name, savingsUSD: m.savingsUSD })),
      byProvider: current.localModelSavings.byProvider.map(p => ({ name: p.name, savingsUSD: p.savingsUSD })),
    },
    optimize: optimize
      ? {
          healthScore: optimize.healthScore,
          healthGrade: optimize.healthGrade,
          costRate: optimize.costRate,
          findings: optimize.findings.map(f => ({ id: f.id, impact: f.impact, tokensSaved: f.tokensSaved, trend: f.trend })),
          modelRecommendations: (optimize.modelRecommendations ?? []).map(r => ({
            fromModel: r.currentModel,
            toModel: r.candidateModel,
            savingsPct: r.savingsPct,
          })),
        }
      : null,
    // Pass-through of the menubar payload's already-capped top-10 usage arrays.
    tools: current.tools.map(t => ({ name: t.name, calls: t.calls })),
    mcpServers: current.mcpServers.map(s => ({ name: s.name, calls: s.calls })),
    skills: current.skills.map(sk => ({ name: sk.name, turns: sk.turns, cost: sk.cost })),
    subagents: current.subagents.map(sa => ({ name: sa.name, calls: sa.calls, cost: sa.cost })),
  }
}

/// An empty snapshot (all zeros / no findings). Used by `otel test` to verify
/// connectivity without a real parse, and as a safe fallback.
export function emptyOtelSnapshot(): OtelSnapshot {
  return {
    cost: 0, estimatedCostUSD: 0, proxiedCostUSD: 0,
    calls: 0, sessions: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    codexCredits: 0, pricingCoverage: null, correctionRate: null,
    categories: [], models: [], providers: [], modelEfficiency: [],
    retryTax: { totalUSD: 0, byModel: [] },
    routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
    localModelSavings: { totalUSD: 0, byModel: [], byProvider: [] },
    optimize: null,
    tools: [], mcpServers: [], skills: [], subagents: [],
  }
}

export function recordMetrics(meter: Meter, snapshot: OtelSnapshot): void {
  const opt = snapshot.optimize
  const findings = opt?.findings ?? []
  const costRate = opt?.costRate ?? 0

  // =========================================================================
  // Gauges: point-in-time ratios/scores (no temporality).
  // =========================================================================

  meter.createGauge('codeburn.health.score')
    .record(opt?.healthScore ?? 100, { grade: opt?.healthGrade ?? 'A' })

  const denom = snapshot.inputTokens + snapshot.cacheReadTokens
  const cacheHit = denom > 0 ? (snapshot.cacheReadTokens / denom) * 100 : 0
  meter.createGauge('codeburn.cache_hit.percent').record(cacheHit)

  // Pricing coverage: only emit when computable — a null must never look like
  // 100% coverage on a dashboard.
  if (snapshot.pricingCoverage !== null) {
    meter.createGauge('codeburn.pricing.coverage').record(snapshot.pricingCoverage)
  }

  // Self-correction rate (0-1): edit turns where the model fixed its own
  // mistake. High values flag models/workflows that thrash.
  if (snapshot.correctionRate !== null) {
    meter.createGauge('codeburn.workflow.correction_rate').record(snapshot.correctionRate)
  }

  // One-shot rate PER ACTIVITY (edits that landed without retries). Skipped for
  // activities with no edit turns (oneShotRate null — nothing to score).
  const oneShotGauge = meter.createGauge('codeburn.oneshot.rate')
  for (const cat of snapshot.categories) {
    if (cat.oneShotRate !== null) {
      oneShotGauge.record(cat.oneShotRate, { activity: cat.name })
    }
  }

  // Per-MODEL efficiency: one-shot rate and cost-per-edit. Distinct from the
  // per-activity oneshot gauge — this is where routing decisions get made.
  const modelOneShotGauge = meter.createGauge('codeburn.model.oneshot_rate')
  const costPerEditGauge = meter.createGauge('codeburn.model.cost_per_edit')
  for (const m of snapshot.modelEfficiency) {
    if (m.oneShotRate !== null) modelOneShotGauge.record(m.oneShotRate, { model: m.name })
    if (m.costPerEdit !== null) costPerEditGauge.record(m.costPerEdit, { model: m.name })
  }

  // Retry rate per model (retries per edit turn) — the leading indicator behind
  // retry tax.
  const retryRateGauge = meter.createGauge('codeburn.retry.rate')
  for (const m of snapshot.retryTax.byModel) {
    if (m.retriesPerEdit !== null) retryRateGauge.record(m.retriesPerEdit, { model: m.name })
  }

  // Routing baseline: the cheapest reliable model's cost-per-edit, the yardstick
  // routing waste is measured against.
  meter.createGauge('codeburn.routing.baseline_cost_per_edit')
    .record(snapshot.routingWaste.baselineCostPerEdit, { model: snapshot.routingWaste.baselineModel || 'none' })

  // Model-switch recommendations: potential % saved by moving from → to.
  const recommendationGauge = meter.createGauge('codeburn.recommendation.savings_pct')
  for (const r of opt?.modelRecommendations ?? []) {
    recommendationGauge.record(r.savingsPct, { from_model: r.fromModel, to_model: r.toModel })
  }

  // Health penalty by waste domain (id-based classification).
  const domainPenalties = new Map<WasteDomain, number>()
  for (const f of findings) {
    const domain = classifyWasteDomain(f)
    domainPenalties.set(domain, (domainPenalties.get(domain) ?? 0) + HEALTH_WEIGHTS[f.impact])
  }
  const penaltyGauge = meter.createGauge('codeburn.health.penalty')
  for (const [domain, penalty] of domainPenalties) {
    penaltyGauge.record(penalty, { domain })
  }

  // =========================================================================
  // ObservableCounters: cumulative accumulating quantities. These report the
  // period's running total; the backend treats them as cumulative counters
  // that reset daily at midnight.
  // =========================================================================

  // Cost: per model, per provider (a genuine split), per activity category,
  // plus a grand total tagged provider='all'.
  const costCounter = meter.createObservableCounter('codeburn.cost.usage')
  costCounter.addCallback((obs) => {
    for (const model of snapshot.models) obs.observe(model.cost, { model: model.name })
    for (const provider of snapshot.providers) obs.observe(provider.cost, { provider: provider.name })
    for (const cat of snapshot.categories) obs.observe(cat.cost, { category: cat.name })
    obs.observe(snapshot.cost, { provider: 'all' })
  })

  // Estimated (guessed) spend: portion of cost priced from estimated tokens.
  const estimatedCostCounter = meter.createObservableCounter('codeburn.cost.estimated')
  estimatedCostCounter.addCallback((obs) => {
    for (const model of snapshot.models) {
      if (model.estimatedCostUSD > 0) obs.observe(model.estimatedCostUSD, { model: model.name })
    }
    obs.observe(snapshot.estimatedCostUSD, { provider: 'all' })
  })

  // Subscription-proxied spend: cost covered by a plan (net = cost - proxied).
  const proxiedCostCounter = meter.createObservableCounter('codeburn.cost.proxied')
  proxiedCostCounter.addCallback((obs) => { obs.observe(snapshot.proxiedCostUSD) })

  // Codex credits consumed (0 when no Codex usage).
  const codexCounter = meter.createObservableCounter('codeburn.codex.credits')
  codexCounter.addCallback((obs) => { obs.observe(snapshot.codexCredits) })

  // Tokens by direction, now including reasoning tokens.
  const tokenCounter = meter.createObservableCounter('codeburn.token.usage')
  tokenCounter.addCallback((obs) => {
    obs.observe(snapshot.inputTokens, { type: 'input' })
    obs.observe(snapshot.outputTokens, { type: 'output' })
    obs.observe(snapshot.reasoningTokens, { type: 'reasoning' })
    obs.observe(snapshot.cacheReadTokens, { type: 'cache_read' })
    obs.observe(snapshot.cacheWriteTokens, { type: 'cache_write' })
  })

  const sessionCounter = meter.createObservableCounter('codeburn.session.count')
  sessionCounter.addCallback((obs) => { obs.observe(snapshot.sessions) })

  // API calls: grand total plus a per-model split.
  const callCounter = meter.createObservableCounter('codeburn.api_call.count')
  callCounter.addCallback((obs) => {
    for (const model of snapshot.models) obs.observe(model.calls, { model: model.name })
    obs.observe(snapshot.calls, { provider: 'all' })
  })

  const turnsCounter = meter.createObservableCounter('codeburn.activity.turns')
  turnsCounter.addCallback((obs) => {
    for (const cat of snapshot.categories) obs.observe(cat.turns, { category: cat.name })
  })

  // --- Tool / MCP / skill / subagent usage (top-10 per dimension) -----------
  // These are top-N slices off the payload, so NO grand total is emitted:
  // summing a slice would undercount days with >10 distinct names, and the
  // snapshot carries no reliable full total for these dimensions. Dashboards
  // read them with `topk(N, sum by (<dim>)(...))`, not as a fleet total.

  // Tool calls per tool: count only. There is no per-tool cost/token
  // attribution in the model (many tools share one API call's cost).
  const toolCallCounter = meter.createObservableCounter('codeburn.tool.calls')
  toolCallCounter.addCallback((obs) => {
    for (const t of snapshot.tools) obs.observe(t.calls, { tool: t.name })
  })

  // MCP server calls per server: count only, same constraint as tools.
  const mcpCallCounter = meter.createObservableCounter('codeburn.mcp.calls')
  mcpCallCounter.addCallback((obs) => {
    for (const s of snapshot.mcpServers) obs.observe(s.calls, { mcp_server: s.name })
  })

  // Skills: turns and attributed cost per skill.
  const skillTurnsCounter = meter.createObservableCounter('codeburn.skill.turns')
  skillTurnsCounter.addCallback((obs) => {
    for (const sk of snapshot.skills) obs.observe(sk.turns, { skill: sk.name })
  })
  const skillCostCounter = meter.createObservableCounter('codeburn.skill.cost')
  skillCostCounter.addCallback((obs) => {
    for (const sk of snapshot.skills) obs.observe(sk.cost, { skill: sk.name })
  })

  // Subagents: dispatch count and attributed cost per subagent type.
  const subagentCallCounter = meter.createObservableCounter('codeburn.subagent.calls')
  subagentCallCounter.addCallback((obs) => {
    for (const sa of snapshot.subagents) obs.observe(sa.calls, { subagent: sa.name })
  })
  const subagentCostCounter = meter.createObservableCounter('codeburn.subagent.cost')
  subagentCostCounter.addCallback((obs) => {
    for (const sa of snapshot.subagents) obs.observe(sa.cost, { subagent: sa.name })
  })

  // --- Realized savings (already avoided) -----------------------------------

  // Local-model savings: counterfactual spend already avoided by running a
  // local model mapped via `codeburn model-savings`. This IS the period's
  // realized-savings headline (snapshot.savingsUSD === totalUSD). Total +
  // by model/provider.
  const localSavingsCounter = meter.createObservableCounter('codeburn.savings.local_model.usd')
  localSavingsCounter.addCallback((obs) => {
    for (const m of snapshot.localModelSavings.byModel) obs.observe(m.savingsUSD, { model: m.name })
    for (const p of snapshot.localModelSavings.byProvider) obs.observe(p.savingsUSD, { provider: p.name })
    obs.observe(snapshot.localModelSavings.totalUSD, { provider: 'all' })
  })

  // --- Waste / hypothetical savings opportunities ---------------------------

  // Retry tax: dollars spent on retried edit turns. Total + per model.
  const retryTaxCounter = meter.createObservableCounter('codeburn.retry_tax.usd')
  retryTaxCounter.addCallback((obs) => {
    for (const m of snapshot.retryTax.byModel) obs.observe(m.taxUSD, { model: m.name })
    obs.observe(snapshot.retryTax.totalUSD, { provider: 'all' })
  })

  // Routing waste: dollars that a cheaper reliable model would have saved.
  const routingWasteCounter = meter.createObservableCounter('codeburn.routing_waste.usd')
  routingWasteCounter.addCallback((obs) => {
    for (const m of snapshot.routingWaste.byModel) obs.observe(m.savingsUSD, { model: m.name })
    obs.observe(snapshot.routingWaste.totalSavingsUSD, { provider: 'all' })
  })

  // Optimize findings by impact severity and by stable finding id.
  const impactCounts: Record<Impact, number> = { high: 0, medium: 0, low: 0 }
  const idCounts = new Map<FindingId, number>()
  for (const f of findings) {
    impactCounts[f.impact]++
    idCounts.set(f.id, (idCounts.get(f.id) ?? 0) + 1)
  }
  const findingsCounter = meter.createObservableCounter('codeburn.optimize.findings')
  findingsCounter.addCallback((obs) => {
    for (const [impact, count] of Object.entries(impactCounts)) obs.observe(count, { impact })
    for (const [id, count] of idCounts) obs.observe(count, { id })
  })

  // Saveable tokens by fixing waste, total + per finding id.
  const savingsByFindingId = new Map<FindingId, number>()
  for (const f of findings) savingsByFindingId.set(f.id, (savingsByFindingId.get(f.id) ?? 0) + f.tokensSaved)
  const totalSaveableTokens = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const savingsTokensCounter = meter.createObservableCounter('codeburn.optimize.savings_tokens')
  savingsTokensCounter.addCallback((obs) => {
    for (const [id, tokens] of savingsByFindingId) obs.observe(tokens, { id })
    obs.observe(totalSaveableTokens, { provider: 'all' })
  })

  // Dollarized optimize savings (tokens × costRate), total + per finding id.
  const savingsUsdCounter = meter.createObservableCounter('codeburn.optimize.savings_usd')
  savingsUsdCounter.addCallback((obs) => {
    for (const [id, tokens] of savingsByFindingId) obs.observe(tokens * costRate, { id })
    obs.observe(totalSaveableTokens * costRate, { provider: 'all' })
  })
}

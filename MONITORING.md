# CodeBurn OpenTelemetry metrics reference

Complete reference for the metrics CodeBurn exports over OpenTelemetry. For setup
(endpoint, SigV4, headers, `codeburn otel` commands) see the
[OpenTelemetry monitoring](README.md#opentelemetry-monitoring) section of the README.

## How metrics are emitted

- **Meter name:** `com.agentseal.codeburn`
- **Protocol:** OTLP/HTTP (standard exporter, or a SigV4-signed exporter for AWS endpoints)
- **Temporality:** `CUMULATIVE` for all sum instruments
- **Scope:** each emission reports **today's running total** (the current local day), anchored to local midnight — see [Cumulative metrics and time](#cumulative-metrics-and-time)
- **Cadence:** one push per emit — the macOS menubar polls ~every 30s; CLI users push once per `--emit-otel` invocation. See the README's [Menubar integration](README.md#menubar-integration).

Metrics come in two instrument families:

- **Gauges** — point-in-time ratios and scores (health, cache hit, one-shot rate, cost-per-edit, …). No temporality; the value is whatever it was at emit time.
- **Observable counters (cumulative sums)** — additive quantities (cost, tokens, calls, savings, waste dollars). These accumulate over the day and reset at midnight.

## Attributes: resource vs. data point

OpenTelemetry has two attribute scopes, and CodeBurn uses both deliberately:

- **Resource attributes** describe *who/where* the metrics came from. They are attached once to the whole export and ride on **every** metric. This is how you slice fleet-wide data by org structure.
- **Data-point attributes** describe *what* a single measurement is about (which model, which provider, which token type, …). They vary point-to-point within one metric.

### Resource attributes

| Attribute | Source | Meaning |
|-----------|--------|---------|
| `service.name` | fixed | Always `codeburn`. |
| `service.version` | package version | The CodeBurn CLI version that emitted the metrics. |
| `codeburn.device_id` | auto | Pseudonymous per-machine id — a salted SHA-256 of `host:username` (16 hex chars), never the raw host or user. Lets you drill down to one developer/machine without exposing identity. |
| `host.name` | auto | OS hostname of the emitting machine (OTel `host.name` convention). |
| *(your config keys)* | `otel.resourceAttributes` | Any keys you set, e.g. `department`, `cost_center`, `team.id`, `user.email`, `organization`. These are the primary org-slicing dimensions. |

Config `resourceAttributes` are applied **last**, so a config key overrides an auto-attached one with the same name (e.g. you can set your own `host.name`). Configure them with `codeburn otel set --resource-attr key=value` (repeatable, accumulates).

### Data-point attributes (glossary)

| Attribute | Appears on | Values / meaning |
|-----------|-----------|------------------|
| `provider` | cost/calls/waste/savings sums | Provider name (`claude`, `codex`, `copilot`, …). The special value **`provider="all"`** marks the grand-total point (see below). |
| `model` | cost/calls/efficiency/waste/savings | Model name (short form, e.g. `claude-sonnet-4-6`). |
| `category` | `cost.usage`, `activity.turns` | Task category (`Coding`, `Debugging`, `Feature`, `Exploration`, …) from the turn classifier. |
| `activity` | `oneshot.rate` | Same task-category name, used for the per-activity one-shot rate. |
| `type` | `token.usage` | Token direction: `input`, `output`, `reasoning`, `cache_read`, `cache_write`. |
| `grade` | `health.score` | Setup health letter grade: `A`, `B`, `C`, `D`, `F`. |
| `domain` | `health.penalty` | Waste domain (see [Waste domains](#waste-domains)). |
| `impact` | `optimize.findings` | Finding severity: `high`, `medium`, `low`. |
| `id` | `optimize.findings`, `optimize.savings_tokens`, `optimize.savings_usd` | Stable finding id (see [Finding ids](#finding-ids)). |
| `from_model` / `to_model` | `recommendation.savings_pct` | Current model → suggested cheaper/faster model for a switch recommendation. |

#### The `provider="all"` convention

Several sums emit both a per-dimension breakdown **and** a single grand-total point tagged `provider="all"`. Read the total directly rather than summing the series:

```promql
codeburn_cost_usage{provider="all"}          # the day's total spend, pre-computed
```

> **Do not sum a whole multi-breakdown metric.** `codeburn.cost.usage` carries three *independent* breakdowns of the same total on one instrument — by `model`, by `provider`, and by `category` — plus the `provider="all"` grand total. A blind `sum(codeburn_cost_usage)` therefore counts the same dollars ~4×. Instead, either read `{provider="all"}` for the total, or select exactly one breakdown by filtering on that key's presence:
>
> ```promql
> sum by (model)    (codeburn_cost_usage{model!=""})       # per-model breakdown
> sum by (provider) (codeburn_cost_usage{provider!="all"}) # per-provider breakdown
> sum by (category) (codeburn_cost_usage{category!=""})    # per-category breakdown
> ```
>
> Each breakdown independently sums back to the grand total. Metrics that carry only a single breakdown plus `provider="all"` (e.g. `retry_tax.usd`, `optimize.savings_tokens`) have the same rule: filter to the breakdown key or read `{provider="all"}`.

## Spend metrics

| Metric | Instrument | Unit | Data-point attributes | Meaning |
|--------|-----------|------|-----------------------|---------|
| `codeburn.cost.usage` | Sum (cumulative) | USD | `model` (per model), `provider` (per provider), `category` (per task category), and `provider="all"` (grand total) | Estimated API cost. Emitted as three independent breakdowns of the same total plus the grand total. |
| `codeburn.cost.estimated` | Sum (cumulative) | USD | `model` (per model, only when > 0), `provider="all"` (total) | Portion of cost priced from *estimated* tokens (guessed vs. metered spend). |
| `codeburn.cost.proxied` | Sum (cumulative) | USD | none | Cost covered by a subscription-backed proxy. Net out-of-pocket = `cost.usage{provider="all"}` − this. |
| `codeburn.codex.credits` | Sum (cumulative) | Codex credits | none | Codex credits consumed in the period (0 when there is no Codex usage). |
| `codeburn.token.usage` | Sum (cumulative) | tokens | `type` (`input`/`output`/`reasoning`/`cache_read`/`cache_write`) | Token consumption by direction and caching. |
| `codeburn.session.count` | Sum (cumulative) | sessions | none | Number of AI coding sessions started. |
| `codeburn.api_call.count` | Sum (cumulative) | calls | `model` (per model), `provider="all"` (total) | API calls, per model and grand total. |
| `codeburn.activity.turns` | Sum (cumulative) | turns | `category` | User turns classified by task type. |
| `codeburn.pricing.coverage` | Gauge | ratio 0–1 | none | Share of cost-bearing calls that resolved a price. **Omitted entirely when not computable** — a missing series means "unknown," never 100%. |

## Efficiency & waste metrics

| Metric | Instrument | Unit | Data-point attributes | Meaning |
|--------|-----------|------|-----------------------|---------|
| `codeburn.cache_hit.percent` | Gauge | percent 0–100 | none | Percentage of input tokens served from prompt cache. |
| `codeburn.oneshot.rate` | Gauge | ratio 0–1 | `activity` | Fraction of edit turns that succeeded without retries, per task category. Activities with no edit turns are omitted. |
| `codeburn.model.oneshot_rate` | Gauge | ratio 0–1 | `model` | One-shot success rate per model (the routing signal). Omitted for models with no scorable edit turns. |
| `codeburn.model.cost_per_edit` | Gauge | USD | `model` | Average cost per edit turn, per model. |
| `codeburn.retry.rate` | Gauge | retries/edit | `model` | Retries per edit turn, per model — the leading indicator behind retry tax. |
| `codeburn.retry_tax.usd` | Sum (cumulative) | USD | `model` (per model), `provider="all"` (total) | Dollars spent on retried edit turns. |
| `codeburn.routing_waste.usd` | Sum (cumulative) | USD | `model` (per model), `provider="all"` (total) | Dollars a cheaper reliable model would have saved. |
| `codeburn.routing.baseline_cost_per_edit` | Gauge | USD | `model` (the baseline model, or `none`) | Cost-per-edit of the cheapest reliable model — the yardstick routing waste is measured against. |
| `codeburn.workflow.correction_rate` | Gauge | ratio 0–1 | none | Fraction of edit turns where the model corrected its own mistake. **Omitted when there are no edit turns.** |
| `codeburn.health.score` | Gauge | score 0–100 | `grade` | Setup health score, with the letter grade as an attribute. |
| `codeburn.health.penalty` | Gauge | penalty points | `domain` | Health-score penalty points attributed to each waste domain. |
| `codeburn.optimize.findings` | Sum (cumulative) | count | `impact` (per severity), `id` (per finding) | Number of waste findings, broken down by severity **and** by specific finding id. |
| `codeburn.optimize.savings_tokens` | Sum (cumulative) | tokens | `id` (per finding), `provider="all"` (total) | Estimated tokens saveable by fixing waste findings. |
| `codeburn.optimize.savings_usd` | Sum (cumulative) | USD | `id` (per finding), `provider="all"` (total) | Dollarized saveable amount (tokens × cost rate). |

## Realized savings & recommendations

| Metric | Instrument | Unit | Data-point attributes | Meaning |
|--------|-----------|------|-----------------------|---------|
| `codeburn.savings.local_model.usd` | Sum (cumulative) | USD | `model` (per model), `provider` (per provider), `provider="all"` (total) | Spend already **avoided** by running local models mapped via `codeburn model-savings`. Distinct from routing/optimize savings, which are *hypothetical* opportunities. |
| `codeburn.recommendation.savings_pct` | Gauge | percent | `from_model`, `to_model` | Potential % saved by switching model, from the optimize scan. Carries no project name/path. |

## Waste domains

`codeburn.health.penalty`'s `domain` attribute groups the individual findings into a
handful of chartable buckets. Domains are assigned from each finding's **stable id**
(not its wording), so they are robust across UI copy changes.

| `domain` | Meaning | Finding ids |
|----------|---------|-------------|
| `context_bloat` | Oversized always-loaded context | `claude-md-too-long`, `unused-agents`, `unused-skills`, `unused-commands` |
| `read_waste` | Inefficient file reading | `read-edit-ratio`, `build-folder-reads`, `redundant-rereads` |
| `cache_waste` | Cache inefficiency | `warmup-heavy` |
| `config_waste` | Suboptimal config settings | `bash-output-cap` |
| `mcp_waste` | MCP server overhead / misconfig | `unused-mcp`, `mcp-low-coverage`, `mcp-project-scope`, `mcp-deferral-off`, `mcp-alwaysload-hygiene`, `mcp-defer-threshold` |
| `session_waste` | Costly / low-value sessions | `low-worth-sessions`, `context-heavy-sessions`, `cost-outliers` |
| `retry_waste` | Retry-heavy capabilities | `retry-heavy-capabilities` |
| `other` | Any finding not yet mapped | *(fallback)* |

## Finding ids

The full set of stable finding ids that appear on the `id` attribute of
`codeburn.optimize.*`:

`read-edit-ratio`, `build-folder-reads`, `redundant-rereads`, `warmup-heavy`,
`unused-mcp`, `mcp-low-coverage`, `mcp-project-scope`, `mcp-deferral-off`,
`mcp-alwaysload-hygiene`, `mcp-defer-threshold`, `retry-heavy-capabilities`,
`low-worth-sessions`, `context-heavy-sessions`, `cost-outliers`, `claude-md-too-long`,
`bash-output-cap`, `unused-agents`, `unused-skills`, `unused-commands`.

## Cumulative metrics and time

The `Sum (cumulative)` metrics report **today's running total** and are anchored to
**local midnight**: every point emitted during a day carries the same `start_time`
(start of the current local day, honoring `--timezone`/`CODEBURN_TZ`), and the counter
resets to zero at midnight. Anchoring to a stable start time (rather than the moment of
each push) means backends that convert cumulative→delta — the OpenTelemetry Collector's
Prometheus exporter, Amazon Managed Prometheus, CloudWatch — see one clean per-day series
instead of a start time that churns on every push.

Because the value resets daily, plot these counters through reset-aware functions rather
than as raw values (standard practice for any counter):

```promql
# Spend rate ($/hour), reset-aware — smooth across midnight
rate(codeburn_cost_usage{provider="all"}[1h]) * 3600

# Per-day total per department — the daily peak IS that day's total
sum by (department) (max_over_time(codeburn_cost_usage{provider="all"}[1d]))

# Rolling 7-day spend, absorbing the daily resets
increase(codeburn_cost_usage{provider="all"}[7d])
```

For a monotonically rising cumulative line, run the per-day query above and apply
Grafana's **"Cumulative sum"** transform. The raw counter value
(`codeburn_cost_usage{provider="all"}`) is a valid "today so far" single-stat.

## Example queries

Slicing fleet-wide data by the org dimensions you set as resource attributes:

```promql
# Spend by department
sum by (department) (codeburn_cost_usage{provider="all"})

# Teams with the highest retry tax (wasted spend on retried edits)
topk(5, sum by (team_id) (codeburn_retry_tax_usd{provider="all"}))

# Routing-waste opportunities by cost center
sum by (cost_center) (codeburn_routing_waste_usd{provider="all"})

# Cache hit rate across the fleet
avg(codeburn_cache_hit_percent)

# Health grade distribution
count by (grade) (codeburn_health_score)

# Realized local-model savings by provider (exclude the provider="all" total)
sum by (provider) (codeburn_savings_local_model_usd{provider!="all"})

# Cost by model (select the model breakdown only)
sum by (model) (codeburn_cost_usage{model!=""})
```

> PromQL replaces `.` with `_` in metric names, so `codeburn.cost.usage` is queried as
> `codeburn_cost_usage`.

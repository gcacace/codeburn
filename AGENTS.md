# AGENTS.md

## Project Overview

CodeBurn is a CLI tool and TUI dashboard that tracks AI coding token usage and costs across multiple providers. It reads session data directly from disk (no API keys, no proxy). Published to npm as `codeburn`.

- **Language:** TypeScript (ESM, strict mode, JSX via react-jsx for Ink TUI)
- **Runtime:** Node.js ≥ 22
- **License:** MIT
- **Entry point:** `src/cli.ts` (thin Node-version launcher that dynamically imports `src/main.ts`) → built to `dist/cli.js` with tsup
- **Native companion:** macOS menubar app in `mac/` (Swift 6, SwiftUI, macOS 14+)

## Build & Test

- `npm run build` — production build via tsup (ESM bundle, `dist/`)
- `npm run dev` — run CLI directly via tsx (`tsx src/cli.ts`)
- `npm test` — run tests via vitest (no config file; vitest auto-discovers `tests/**/*.test.ts`)
- Tests live in `tests/` (not `src/`), mirroring source structure. Provider tests are in `tests/providers/`.
- No separate lint command — Semgrep runs in CI for security rules only (see below).

## Architecture

### Provider Plugin System

Providers live in `src/providers/`. Each implements the `Provider` interface from `src/providers/types.ts`:
- `discoverSessions()` — finds session files on disk
- `createSessionParser()` — returns an async generator of `ParsedProviderCall`

Core providers (always loaded): `claude`, `codex`, `copilot`, `pi`, `omp`
Optional providers (lazy-loaded, require `better-sqlite3`): `cursor`, `opencode`, `cursor-agent`

Optional AWS dependencies (`@aws-sdk/credential-provider-node`, `@aws-sdk/signature-v4`, `@smithy/protocol-http`, `@aws-crypto/sha256-js`) are lazy-loaded at runtime by `otel-sigv4.ts` using the same dynamic `import()` + try/catch pattern as Cursor/OpenCode. The OTEL core (`@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`) is also lazy-loaded so the CLI works without these packages installed unless OTEL is enabled.

Provider registry is in `src/providers/index.ts`. Lazy loading uses dynamic `import()` with try/catch so the CLI works without `better-sqlite3` installed.

### Key Modules

| Module | Purpose |
|---|---|
| `cli.ts` | Thin launcher: enforces the Node version floor, then dynamically imports `main.ts` (kept parseable by old Node — no static imports) |
| `main.ts` | Commander-based CLI with subcommands (report, status, export, optimize, yield, plan, config, otel, etc.) |
| `parser.ts` | Reads session files via providers, builds `ProjectSummary[]` |
| `usage-aggregator.ts` | Builds `PeriodData` / durable-period totals and the menubar payload shared by CLI, TUI, MCP, and menubar |
| `models.ts` | Model pricing from LiteLLM (auto-cached 24h) with hardcoded fallbacks |
| `classifier.ts` | Classifies user turns into `TaskCategory` (coding, debugging, feature, etc.) |
| `dashboard.tsx` | Ink/React TUI with gradient charts, keyboard nav, auto-refresh |
| `compare.tsx` | Model comparison view (Ink/React) |
| `optimize.ts` | Waste detection: bloated CLAUDE.md, junk reads, duplicate reads, edit/read ratio |
| `yield.ts` | Experimental: productive vs reverted/abandoned spend via git history |
| `context-budget.ts` | Estimates context window budget (MCP tools, skills, memory files) |
| `daily-cache.ts` | File-based daily aggregation cache for fast repeated queries |
| `day-aggregator.ts` | Aggregates `ProjectSummary[]` into per-day buckets |
| `menubar-json.ts` | Builds JSON payload for the macOS menubar app |
| `config.ts` | User config at `~/.config/codeburn/config.json` (currency, plan, model aliases) |
| `currency.ts` | Multi-currency support with conversion |
| `plan-usage.ts` | Subscription plan budget tracking |
| `export.ts` | CSV and JSON export |
| `otel.ts` | OpenTelemetry MeterProvider init, `buildResource` (auto-attaches `codeburn.device_id` + `host.name`), `emitOtelMetrics(config, OtelSnapshot)` orchestrator |
| `otel-sigv4.ts` | Custom OTLP exporter with AWS SigV4 signing (lazy-loads AWS SDK) |
| `otel-headers.ts` | Dynamic headers helper for enterprise OTEL auth |
| `otel-metrics.ts` | `OtelSnapshot` type + `buildOtelSnapshot`/`recordMetrics`: maps a snapshot to OTEL instruments (spend, efficiency/waste, realized savings, model recommendations, top-N tool/MCP/skill/subagent usage); waste domains keyed by stable `FindingId` |

### Data Flow

1. `getAllProviders()` returns all available providers
2. Each provider's `discoverSessions()` finds session files on disk
3. `parseAllSessions()` iterates providers, parses sessions into `ProjectSummary[]`
4. Results are aggregated, classified, and rendered (TUI, JSON, CSV)

### OtelConfig Schema

The `otel` key in `~/.config/codeburn/config.json` controls OpenTelemetry metric export:

```typescript
interface OtelConfig {
  enabled: boolean                          // master toggle
  endpoint: string                          // OTLP HTTP endpoint (e.g. http://localhost:4318/v1/metrics)
  sigv4?: {                                 // optional AWS SigV4 signing
    region: string                          // AWS region (e.g. us-west-2)
    service: string                         // AWS service name (e.g. monitoring)
    profile?: string                        // optional AWS credentials profile
  }
  headersHelper?: string                    // path to executable that outputs JSON headers to stdout
  resourceAttributes?: Record<string, string> // extra OTEL resource attributes (e.g. department, cost_center, team.id, user.email, organization)
}
```

`resourceAttributes` are the org-slicing dimensions: they ride on every emitted metric so a company can group fleet-wide spend/waste by department, team, cost center, etc. `buildResource` also auto-attaches a pseudonymous `codeburn.device_id` (SHA-256 hash of host+username) and `host.name` for per-developer drill-down; config attributes are spread last and win on key collision.

Emission flows through `buildOtelSnapshot(payload.current, optimize, liveProjects)` → `emitOtelMetrics(config, snapshot, dayStart)`. The `OtelSnapshot` carries the rich menubar-grade figures (real per-provider cost, per-model efficiency, retry tax, routing waste, realized local-model savings, model recommendations) so the instruments have data without re-aggregating. `main.ts`'s `emitOtelSnapshot` reuses the menubar payload it already built on the `status --format menubar-json` today poll (the menubar's ~30s refresh); for non-menubar users it rebuilds from cache when `--emit-otel` is passed to `report --format json` or `status`. All emission is fire-and-forget; `otel test` awaits an `emptyOtelSnapshot()` send to verify connectivity.

Cumulative counters report today's running total and are anchored to local midnight: `emitOtelMetrics` takes the snapshot's `dayStart` (`getDateRange('today').range.start`, passed in so it matches the exact day the values cover) and `StartTimeOverrideExporter` (`otel-start-time.ts`) pins every data point's `startTimeUnixNano` to it before the standard/SigV4 exporter serializes — so the series is a clean per-day counter rather than one whose start time churns on every push.

## Coding Conventions

### Prototype Pollution Guard (CI-enforced)

Semgrep rule `.semgrep/rules/no-bracket-assign-hot-paths.yml` blocks bracket-assign on literal `{}` objects in `src/providers/` and `src/parser.ts`. When building maps from external data, always use `Object.create(null)`:

```typescript
// ✅ Correct
const map: Record<string, number> = Object.create(null)
map[externalKey] = value

// ❌ Will fail CI
const map: Record<string, number> = {}
map[externalKey] = map[externalKey] ?? 0
```

### TypeScript Style

- ESM imports with `.js` extensions (required for Node ESM resolution)
- No default exports — use named exports
- Types defined in `src/types.ts` (core domain) and `src/providers/types.ts` (provider interface)
- Strict mode enabled; no `any` unless unavoidable

### TUI Components

Dashboard and compare views use Ink (React for terminal). Components are `.tsx` files. The TUI uses `useInput` for keyboard handling and `useWindowSize` for responsive layout.

## Testing

- Framework: vitest (v3.1+)
- Pattern: `tests/<module>.test.ts` and `tests/providers/<provider>.test.ts`
- Security tests: `tests/security/prototype-pollution.test.ts` with fixtures in `tests/fixtures/security/`
- Tests are pure unit tests — no network calls, no disk I/O to real session dirs
- Run a single test file: `npx vitest run tests/<file>.test.ts`

## macOS Menubar App

Located in `mac/`. Swift Package Manager project (`Package.swift`). Reads JSON from the CLI (`codeburn status --format json`). Build with `swift build` from `mac/`. Has its own release workflow (`.github/workflows/release-menubar.yml`).

## CI

- GitHub Actions (`.github/workflows/ci.yml`): Semgrep bracket-assign guard on `src/providers/` and `src/parser.ts`
- `.github/workflows/block-claude-coauthor.yml`: blocks PRs with Claude as co-author
- `.github/workflows/release-menubar.yml`: macOS menubar app release
- `.github/workflows/firstlook.yml`: first-look workflow

## Custom Instructions

<!-- Add repo-specific rules and gotchas below this line -->

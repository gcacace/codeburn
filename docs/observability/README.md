# Grafana dashboard

[`grafana-dashboard.json`](grafana-dashboard.json) is an importable Grafana dashboard —
**"CodeBurn — AI Coding Spend & Efficiency"** — that visualizes the `codeburn.*`
OpenTelemetry metrics CodeBurn exports (see [../../MONITORING.md](../../MONITORING.md) for
the full metric reference and [the README's OpenTelemetry section](../../README.md#opentelemetry-monitoring)
for how to turn export on).

It has three sections — **Spend**, **Efficiency & waste**, and **Realized savings &
recommendations** — and two template variables, **Department** and **Device**, that slice
every panel by the `@resource.department` / `@resource.codeburn.device_id` resource
attributes. The top row is single-value stat tiles aggregated across the selected fleet
(`sum` for dollars/tokens/counts, `avg` for rates and scores); everything below breaks the
fleet out into per-model / per-provider / per-category series.

## Requirements

- A Prometheus-compatible data source pointed at wherever your `codeburn.*` metrics land.
  It was built against **CloudWatch's PromQL-compatible API** via the Grafana
  **`grafana-amazonprometheus-datasource`** (Amazon Managed Prometheus / Amazon Managed
  Grafana), but any Prometheus data source over the same metrics works.
- The metrics must actually be flowing — configure `codeburn otel set --endpoint … --sigv4-…`
  (or point the exporter at your collector) so the `codeburn.*` series exist.

## Import

1. In Grafana: **Dashboards → New → Import**.
2. Upload `grafana-dashboard.json` (or paste its contents).
3. When prompted, select your Prometheus/AMP data source for the **Data source** variable.
4. Save. Adjust the **Department** / **Device** variables (default `All`) to scope the view.

Or via the HTTP API:

```bash
curl -H "Authorization: Bearer $GRAFANA_TOKEN" -H "Content-Type: application/json" \
  -X POST "$GRAFANA_URL/api/dashboards/db" \
  -d "{\"dashboard\": $(cat grafana-dashboard.json), \"overwrite\": true}"
```

The template's data source is a variable (not a hardcoded UID), so it prompts on import and
carries no workspace-specific identifiers.

## Metric-name syntax note (CloudWatch PromQL)

CodeBurn's metric names contain dots (`codeburn.cost.usage`). Against the CloudWatch
PromQL-compatible API the panels select them with the **quoted, dotted** matcher form
rather than the Prometheus underscore convention:

```promql
# correct for this data source
sum by (model) ({"codeburn.cost.usage", model!=""})

# NOT codeburn_cost_usage{...}
```

Resource attributes surface as `@resource.*` labels (e.g. `@resource.department`,
`@resource.codeburn.device_id`, `@resource.host.name`). If you point the dashboard at a
plain Prometheus (underscore metric names, no `@resource.` prefix), you'll need to adjust the
panel expressions accordingly.

## Regenerating

The committed file is a portability-cleaned export (data source as a variable, no instance
IDs/version). To refresh it after editing in Grafana, export the dashboard JSON, replace the
data source UID with the `${datasource}` variable, and strip `id`/`version`/`iteration`
before committing.

---
name: watch-metric
description: Check a metric against a threshold and alert only when it's breached. Use when the user (or a scheduled run) says "watch X", "alert me if Y drops below Z", "check that signups stayed above N", or any threshold-check request.
---

# Watch a metric, alert on breach

Turn "tell me if weekly signups drop below 100" into a scheduled check that stays quiet until something is wrong.

## Steps

1. **Parse the watch spec from the invoking prompt:** the metric, the threshold and direction (below/above), and the window (default: last 7 full days). If the spec is ambiguous in a scheduled run, state the interpretation you used — never silently guess a different metric.
2. **Measure.** Pick the right source: `posthog` MCP for product/traffic metrics, `twenty` MCP for pipeline counts/values, `knowledge/finance/` for money facts. Query exactly the window asked for and note the query you ran.
3. **Compare and report:**
   - **Breached** → write `outbox/alerts/<YYYY-MM-DD>-<metric-slug>.md` with: the number, the threshold, the same metric for the two prior windows (trend context), and 2–3 plausible causes drawn from `knowledge/` (releases, campaigns, seasonality). Open with one plain sentence: "⚠️ <metric> is <value>, below <threshold>."
   - **Fine** → a one-line all-clear with the number. No file, no drama.
4. **Exactness rules:** real numbers only — never invent or extrapolate; small counts as absolutes, not percentages; say when data is missing or the tool call failed instead of substituting.

## Scheduling

This skill is designed for a scheduled run, e.g. a weekly job with the prompt:
`Use the watch-metric skill: alert if weekly signups (PostHog event "signup") drop below 100.`
Background runs can only use always-allowed tools — if a needed tool is denied, say what was skipped.

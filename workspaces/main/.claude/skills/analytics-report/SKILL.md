---
name: analytics-report
description: Pull PostHog analytics for a period and produce a readable report. Use when the user asks "how's traffic/usage", "analytics for last month", "what do the numbers look like", or wants a metrics summary.
---

# Analytics report from PostHog

## Steps

1. **Scope the period.** Use what the user named; default to the last 7 full days. Always state the exact date range in the report.
2. **Pull via the `posthog` MCP tools:**
   - Headline: unique users, sessions/pageviews, top events for the period, each vs the previous equivalent period.
   - Top pages/screens and top referral sources (if web analytics is enabled).
   - Any insight the user specifically asked about (funnel, retention, a named event).
3. **Interpret, don't dump.** For each notable movement (>20% change), say what moved, and check for explanations: known releases or campaigns in `knowledge/product/` and `knowledge/brand/`, weekday/holiday effects. Distinguish "explained" from "worth investigating".
4. **Report shape:** headline paragraph → small metrics table (metric · this period · previous · Δ) → notable movements with interpretation → open questions.
5. If the user wants it kept, write the report to `outbox/<YYYY-MM-DD>-analytics-<period-slug>.md`; otherwise just answer in chat.

## Rules

- Never invent numbers. If a query fails or a metric isn't tracked, say exactly that.
- Small absolute numbers → report absolute changes, not just percentages ("3 → 7 signups", not "+133%").

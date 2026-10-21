---
name: crm-status
description: Report the current state of the Twenty CRM pipeline and draft follow-up emails for pending/stuck items. Use when the user asks "what's the status", "CRM update", "what's pending", "who do I need to follow up with", or asks for follow-up email drafts.
---

# CRM status & follow-up drafts

## Steps

1. **Pull the pipeline** via the `twenty` MCP tools: open opportunities/deals with stage and last-activity date, open tasks with due dates, and recently touched people/companies. If a query fails, say which tool failed and continue with what you have.
2. **Analyze:**
   - Group deals by stage; flag anything **stale** (no activity in 14+ days) or **overdue** (task past due).
   - Cross-reference `knowledge/clients/` for context on flagged items (recorded terms, sensitivities, history).
3. **Report** in this shape:
   - One-paragraph headline: pipeline health in plain words.
   - Table: deal/company · stage · value (if tracked) · last activity · what's blocking.
   - "Needs action" list, most urgent first.
4. **Draft follow-ups** for each item that needs one:
   - Use `templates/email-follow-up.md` and the voice rules in CLAUDE.md.
   - Personalize from CRM data + `knowledge/clients/` — reference the real last touchpoint, never generic filler.
   - **Where drafts go:** if the `google` MCP tools are available, create each draft directly in Gmail with `gmail_create_draft` (recipient from the CRM) — that puts it one click from send in the user's own mail. Only when Google is not connected, fall back to writing `outbox/<YYYY-MM-DD>-email-<company>-<slug>.md` with a recipient header.
5. **Close** by listing the Gmail drafts (or outbox files) created. Never send anything; drafts are for human review.

## Rules

- The CRM is the source of truth for facts; the knowledge base is the source of truth for context and tone toward each client.
- If the user names a period ("this week's status"), scope activity queries to it; default lookback is 30 days.

---
name: morning-briefing
description: Compile the daily chief-of-staff briefing — calendar, email, CRM, money, analytics — into one digest. Use when the user asks for "the briefing", "what's my day look like", "morning update", or when triggered by a scheduled run.
---

# Morning briefing

One digest that means the user doesn't have to check five apps. Pull only from available tools; skip sections whose tool is unavailable or fails, noting the skip in one line.

## Gather (in this order)

1. **Today's calendar** — `calendar_list_events` from now to end of day (and note tomorrow's first event if today is empty).
2. **Email needing attention** — `gmail_search` for `is:unread newer_than:2d` and `in:inbox newer_than:4d -is:unread` from known clients (names from `knowledge/clients/` and the CRM); list who's waiting on a reply.
3. **CRM pulse** — via `twenty`: deals with no activity in 14+ days, tasks due today/overdue.
4. **Money** — grep `knowledge/finance/` for due dates within 7 days (payables and receivables).
5. **Product** — via `posthog`: yesterday's headline metric vs the day before; flag only meaningful movement (>20%).
6. **Commitments** — grep `knowledge/` for deadlines/obligations falling within 7 days (proposals due, contract dates).

## Compose

- Start with a 2–3 sentence plain-language summary of the day: the one thing that matters most first.
- Then short sections (skip empty ones): 📅 Today · ✉️ Waiting on you · 📊 Pipeline · 💶 Money · 📈 Product · ⏳ Deadlines.
- Every line actionable and specific: "Reply to Jane (Acme) — DPA question, 2 days old", not "check email".
- Save a copy to `outbox/briefings/<YYYY-MM-DD>-briefing.md` (later briefings read it for carry-over).
- The briefing is delivered as its Monad thread — don't create a Gmail draft or any email of it.

## Rules

- Read-only: this skill never sends, drafts email, modifies CRM records, or creates events.
- In scheduled (background) runs some tools may be denied — work with what's allowed and say what was skipped.
- No padding. A quiet day should produce a three-line briefing, and that's a good briefing.

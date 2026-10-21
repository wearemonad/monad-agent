---
name: draft-contract
description: Draft a contract for a client using the company template and CRM data. Use when the user asks to "draft a contract", "prepare an agreement", or "make the contract for <client>".
---

# Draft a contract for a client

## Steps

1. **Identify the client** in Twenty via the `twenty` MCP: company record, primary contact, address, and any deal/opportunity this contract belongs to. If the name is ambiguous (multiple matches), list the matches and ask which one — this is a legal document, don't guess identities.
2. **Gather terms**, in priority order:
   1. What the user specified in their request (fee, scope, dates).
   2. The CRM deal record (value, notes).
   3. `knowledge/clients/<client>.md` and `knowledge/legal/` (agreed terms, jurisdiction conventions, past contracts).
3. **Fill the template** `templates/contract-services.md` (or another template in `templates/` if the user names one). Every `{{placeholder}}` must end up either filled or listed as an explicit `**[TODO: …]**` marker in the draft — never silently dropped, never invented. Monetary amounts, dates, and legal names must come from a source you can cite.
4. **Write the draft** to `outbox/<YYYY-MM-DD>-contract-<client-slug>.md`.
5. **Report:** the output path, a bullet list of filled terms **with their source** (CRM field / knowledge doc / user message), and the list of TODOs a human must resolve before sending.

## Rules

- This is a draft for review by a human (and, for anything material, a lawyer) — say so in the report.
- If the knowledge base records terms that contradict the user's request (e.g. different payment days), flag the conflict instead of silently picking one.

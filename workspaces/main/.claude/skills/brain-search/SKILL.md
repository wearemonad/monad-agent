---
name: brain-search
description: Find anything in the company knowledge base or past conversations. Use when the user asks "what do we know about X", "find the document about Y", "did we agree Z with <client>", or any question answerable from recorded company knowledge.
---

# Search the company brain

## Steps

1. **About a specific person, company or project?** Start with `memory_entity` — its page, every linked document, related entities and its CRM id in one call. `memory_entities` lists entities (by type, or "not mentioned in N days").
2. **Memory search:** `memory_search` — it matches by MEANING across knowledge docs AND past conversations ("payment terms" finds the doc that says "net-30"), and returns excerpts with source + date. Use `memory_session` to read more of a conversation hit.
3. **Then the catalog and grep:** read `knowledge/INDEX.md` for the one-line summaries, and `grep -ril "<term>" knowledge/` (synonyms, client names, entity names) when you need exhaustive coverage or the full text of a document.
4. **If the question touches live data** (deal status, current numbers), also check the `twenty` or `posthog` MCP (use the entity's CRM id when it has one) — the knowledge base can be stale; say which source is newer if they disagree.
5. **Answer with citations:** every claim names its file (`knowledge/clients/acme.md`) or tool source. Quote exact figures/dates rather than paraphrasing them.
6. **If nothing is found, say so plainly** — "the brain has no record of X" — and suggest where it would live if ingested. Never fill gaps with plausible-sounding guesses.

## Rules

- Originals in `knowledge/originals/` are a last resort (e.g. verifying an exact contract clause); prefer the processed docs.
- If you notice the INDEX is out of sync with the actual files, fix it as you go and mention it.

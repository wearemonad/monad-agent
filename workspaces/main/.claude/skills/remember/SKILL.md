---
name: remember
description: Save, update, or forget a durable fact in working memory. Use when the user says "remember this", "note that", "don't forget", "actually it's X now", or "forget about Y" — or when they reveal a lasting preference, commitment, or open decision in passing.
---

# Remember — curate working memory

Working memory (`knowledge/working-memory.md`) is the small snapshot injected into EVERY session. Curate it with the `memory_remember` tool — never edit the file directly.

## Judgment rules (edit these as you learn what's worth keeping)

- **Declarative facts, not instructions.** "User prefers short emails" ✓ — "Always write short emails" ✗. Imperatives get re-read as directives next session.
- **Durable only.** If it will be stale in a week (task progress, "X is fixed", counts), it belongs in a knowledge doc or nowhere — not here.
- **Dedup before adding.** The snapshot is already in your context — if a fact is superseded, `replace` it; contradictions must not coexist.
- **Sections:** `active-threads` = ongoing workstreams · `key-facts` = stable facts & preferences · `pending-decisions` = open calls awaiting the user.
- **At capacity, consolidate first.** Merge related entries or drop the least valuable, then add.
- Bigger things worth keeping (documents, meeting outcomes, reference material) → ingest into `knowledge/` instead; working memory holds pointers, not payloads.

Writes apply from the next session. Confirm to the user in one short line what was saved/changed.

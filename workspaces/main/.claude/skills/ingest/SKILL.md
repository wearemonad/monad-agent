---
name: ingest
description: Process new files from inbox/ into the knowledge base. Use when files have been dropped into inbox/, when the user says "ingest", "process the inbox", "I added some files", or when a session notices unprocessed files in inbox/.
---

# Ingest inbox files into the knowledge base

Turn raw dumped files (PDFs, images, screenshots, docs, notes, emails, meeting transcripts, saved web pages) into searchable knowledge documents, so the brain knows their content without ever loading originals into chat context.

## Steps

1. **List the inbox.** `ls inbox/` (ignore dotfiles and `.gitkeep`). If empty, say so and stop. Report how many files you're processing.
2. **For each file:**
   a. Read it directly (Claude reads PDFs and images natively). For formats you cannot read (e.g. `.docx`, `.xlsx`), try converting first: `textutil -convert txt -stdout <file>` (macOS) for docx; for spreadsheets try `python3 -c` with openpyxl/csv, and if nothing works, record it in the index as "unprocessed original" instead of guessing.
   b. Write a knowledge document in the best-fitting `knowledge/` subfolder (`clients/`, `finance/`, `legal/`, `product/`, `brand/`), kebab-case filename, with the frontmatter convention from CLAUDE.md (source, ingested date, tags, entities).
      - The document should capture everything a future session might need: key facts, numbers, dates, names, obligations. For images/screenshots: describe what's shown and transcribe any text. Summarize; don't paste raw dumps of long documents — extract the durable facts.
      - If the file relates to an existing knowledge doc (same client, same topic), **update that doc** instead of creating a near-duplicate.
   c. **Connect it to the knowledge graph.** First check `memory_entities` (or `ls knowledge/entities/`) so you reuse existing canonical names instead of inventing near-duplicates ("Acme GmbH", not "ACME" in one doc and "Acme Ltd" in another).
      - Put the people, companies and projects the document is about in its `entities:` frontmatter, and link them in the text as `[[Canonical Name]]`.
      - For each recurring or significant entity, create or update its page `knowledge/entities/<kebab-name>.md`:

        ```markdown
        ---
        type: company            # person | company | project | …
        aliases: [Acme, ACME Holdings]
        crm: <record id>         # only if the twenty CRM has it
        ---
        # Acme GmbH

        One paragraph: who/what they are and how they relate to us.

        ## Key facts
        - 2026-08-01 — Signed services contract, net-30 ([[acme-services-contract]])
        ```

      - Passing mentions (someone cc'd once) only go in `entities:` — no page.
   d. Move the original: `mv "inbox/<file>" "knowledge/originals/<YYYY-MM-DD>-<file>"`. Never delete anything.
3. **Update `knowledge/INDEX.md`** — one line per new/updated document under its folder heading: `path — one-sentence summary — [tags]` (entity pages under `entities/`).
4. **Report** a short summary: N files processed, where each went, entities created or updated, anything you couldn't read, and anything surprising the user should look at (e.g. an invoice that contradicts recorded terms).

## Transcript mode

For meeting transcripts (`.vtt`, `.srt`, Zoom/Granola/Meet exports, or any file that reads as a timestamped conversation):

- Strip timestamps/speaker noise; extract **decisions made**, **action items with owners and deadlines**, **attendees**, and durable facts (numbers, dates, commitments).
- Write the knowledge doc under the client's folder when the meeting is about one client, else `knowledge/notes/`, with `tags: [meeting, …]` and the attendees as `entities`.
- When action items include follow-ups we owe someone, also draft them: `outbox/<YYYY-MM-DD>-email-<who>-<topic>.md` (or a Gmail draft if the `google` tools are available). Drafts only — never send.

## Email mode

Files named `email-*.md` (pulled from Gmail by the app) carry frontmatter with sender and any saved attachments. Treat the attachments listed there as part of the same email: ingest them together, cross-reference in one knowledge doc where sensible, and tag with the sender's company/entity.

## Rules

- Ambiguous category → pick the best fit and note the choice in the report; do not stall to ask.
- Sensitive content (contracts, financials) → extra care transcribing numbers, dates, and names; these get checked by other skills later.
- Filename collisions in `originals/` → append `-2`, `-3`, ….

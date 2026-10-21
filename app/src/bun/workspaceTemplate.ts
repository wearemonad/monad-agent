/** Files scaffolded into a newly created workspace. Mirrors workspaces/main in the
 *  repo — embedded here so the packaged app is self-contained. */

import { workingMemoryTemplate } from "./services/workingMemory";
import { WORKING_MEMORY_PATH } from "../shared/memory";

const CLAUDE_MD = `# Company Brain

This workspace is the persistent brain for the company. Every session here should behave like a chief-of-staff who already knows the business. Company facts live in this file and in \`knowledge/\`; never ask the user for something that is recorded here — look it up.

<!-- TODO: fill in every [bracketed] field below. The brain is only as good as this section. -->

## The company

- **Name:** [company name]
- **What we do:** [one paragraph: product/service, who buys it, how we make money]
- **Stage & size:** [e.g. 3 people, bootstrapped]
- **Website:** [url]
- **Key people:** [name — role — what they own]

## Clients & pipeline

- CRM is **Twenty** (via the \`twenty\` MCP server) — the source of truth for people, companies, deals, and tasks.
- [List the most important clients and anything unusual about each]

## Voice & tone

- Emails: [style, sign-off]
- Contracts/legal: [style, jurisdiction]

## Tools

- **twenty** MCP — CRM · **posthog** MCP — analytics · **google** MCP (when connected) — gmail search/read/draft (never sends), calendar list/create
- \`inbox/\` — new files land here (drag-drop, Drive sync, Gmail label "Monad", watched local folder, pasted URLs); process with the \`ingest\` skill
- \`knowledge/\` — the processed knowledge base; \`knowledge/INDEX.md\` catalogs every document
- \`templates/\` — contract and email templates
- \`outbox/\` — drafts for human review; nothing is ever sent automatically

## Operating rules

1. **Ground answers in tools, not context.** Search memory first (\`memory_search\` — knowledge docs and past conversations, by meaning), then \`knowledge/INDEX.md\`/grep or the CRM/analytics. Say when the brain has no record of something.
2. **Drafts, never sends.** Client-facing output goes to \`outbox/\` as files.
3. **Cite the source.** Name the file(s) or tool behind every claim.
4. **Keep the brain current.** Record durable new facts in \`knowledge/\` and update \`INDEX.md\`; lasting preferences, active threads and open decisions go to working memory via \`memory_remember\` (see the \`remember\` skill).
5. **Money & legal need care.** Double-check amounts and terms against \`knowledge/finance/\` and \`knowledge/legal/\`; flag uncertainty.

## Knowledge base conventions

- Markdown, kebab-case filenames, in the best-fitting subfolder: \`clients/\`, \`finance/\`, \`legal/\`, \`product/\`, \`brand/\`.
- Frontmatter on every doc: \`source\`, \`ingested\` (YYYY-MM-DD), \`tags\`, \`entities\`.
- **Knowledge graph:** \`entities\` lists the canonical names of the people, companies and projects a doc is about; link them inline as \`[[Canonical Name]]\`. Each recurring entity gets one page, \`knowledge/entities/<kebab-name>.md\` (frontmatter \`type\`: person/company/project/…, \`aliases\`, \`crm\`: the CRM record id when known) — update it, never duplicate. The app builds the graph from these; \`memory_entity\` reads it.
- Originals are archived untouched in \`knowledge/originals/\` after ingestion — never deleted.
`;

const MCP_JSON = `{
  "mcpServers": {
    "twenty": {
      "command": "npx",
      "args": ["-y", "twenty-crm-mcp-server"],
      "env": {
        "TWENTY_API_KEY": "\${TWENTY_API_KEY}",
        "TWENTY_BASE_URL": "\${TWENTY_BASE_URL}"
      }
    },
    "posthog": {
      "type": "http",
      "url": "https://mcp.posthog.com/mcp",
      "headers": {
        "Authorization": "Bearer \${POSTHOG_PERSONAL_API_KEY}"
      }
    }
  }
}
`;

const INDEX_MD = `# Knowledge Index

One line per document: \`path — summary — [tags]\`. Sorted by folder. Maintained by the \`ingest\` skill.

## clients/

_(empty)_

## finance/

_(empty)_

## legal/

_(empty)_

## product/

_(empty)_

## brand/

_(empty)_

## entities/

_(empty)_

## notes/

_(empty)_
`;

export const SKILL_INGEST = `---
name: ingest
description: Process new files from inbox/ into the knowledge base. Use when files have been dropped into inbox/, when the user says "ingest", "process the inbox", "I added some files", or when a session notices unprocessed files in inbox/.
---

# Ingest inbox files into the knowledge base

Turn raw dumped files (PDFs, images, screenshots, docs, notes, emails, meeting transcripts, saved web pages) into searchable knowledge documents.

## Steps

1. **List the inbox.** \`ls inbox/\` (ignore dotfiles). If empty, say so and stop.
2. **For each file:** read it directly (PDFs and images natively; try \`textutil -convert txt -stdout\` for docx). Write a knowledge doc in the best-fitting \`knowledge/\` subfolder with the frontmatter convention from CLAUDE.md. Capture key facts, numbers, dates, names, obligations; describe images and transcribe their text. Update an existing doc instead of creating a near-duplicate. Then \`mv\` the original to \`knowledge/originals/<YYYY-MM-DD>-<file>\`. Never delete.
3. **Connect it to the graph.** Check \`memory_entities\` (or \`ls knowledge/entities/\`) and reuse existing canonical names. Put the people/companies/projects the doc is about in \`entities:\` and link them in the text as \`[[Canonical Name]]\`. For each recurring or significant entity, create or update \`knowledge/entities/<kebab-name>.md\`: frontmatter \`type\`, \`aliases\`, \`crm\` (record id, if the \`twenty\` CRM has it); body = \`# Canonical Name\`, one who/what paragraph, then dated key facts linking back to the source doc. Passing mentions only go in \`entities:\`.
4. **Update \`knowledge/INDEX.md\`** — one line per new/updated doc (entity pages under \`entities/\`).
5. **Report:** N files processed, where each went, entities created/updated, anything unreadable or surprising.

## Transcript mode

Meeting transcripts (\`.vtt\`, \`.srt\`, Zoom/Granola/Meet exports, timestamped conversations): strip timestamps; extract **decisions**, **action items with owners/deadlines**, **attendees**, durable facts. File under the client's folder (or \`knowledge/notes/\`), \`tags: [meeting, …]\`, attendees as \`entities\`. Follow-ups we owe someone → draft to \`outbox/\` (or Gmail draft if \`google\` tools are available). Drafts only — never send.

## Email mode

\`email-*.md\` files (pulled from Gmail by the app) carry frontmatter with sender + saved attachments. Ingest the listed attachments as part of the same email; cross-reference in one knowledge doc where sensible.

## Rules

- Ambiguous category → pick the best fit and note it; don't stall.
- Extra care transcribing numbers/dates/names in contracts and financials.
- Filename collisions in originals/ → append -2, -3, …
`;

const SKILL_CRM_STATUS = `---
name: crm-status
description: Report the current state of the Twenty CRM pipeline and draft follow-up emails for pending/stuck items. Use when the user asks "what's the status", "CRM update", "what's pending", or asks for follow-up drafts.
---

# CRM status & follow-up drafts

1. **Pull the pipeline** via the \`twenty\` MCP: open deals with stage + last activity, open tasks with due dates, recently touched people/companies.
2. **Analyze:** group by stage; flag stale (no activity 14+ days) and overdue items; cross-reference \`knowledge/clients/\` for context.
3. **Report:** headline paragraph → table (deal · stage · value · last activity · blocker) → "needs action" list, most urgent first.
4. **Draft follow-ups** using \`templates/email-follow-up.md\` and the CLAUDE.md voice rules, personalized from CRM + knowledge. If the \`google\` MCP tools are available, create each draft in Gmail with \`gmail_create_draft\`; otherwise write \`outbox/<YYYY-MM-DD>-email-<company>-<slug>.md\` with a recipient header.
5. List the Gmail drafts (or outbox files) created. Never send anything.
`;

const SKILL_BRIEFING = `---
name: morning-briefing
description: Compile the daily chief-of-staff briefing — calendar, email, CRM, money, analytics — into one digest with a suggested focus for the day. Use when the user asks for "the briefing", "what's my day look like", "what should I do today", "morning update", or when triggered by a scheduled run.
---

# Morning briefing

One digest so the user doesn't have to check five apps. Pull only from available tools; skip failed/unavailable sections with a one-line note.

1. **Calendar** — \`calendar_list_events\` now → end of day.
2. **Email** — \`gmail_search\` unread (2d) + unanswered client threads (4d); who's waiting on a reply.
3. **CRM** — via \`twenty\`: stale deals (14+ days), tasks due/overdue.
4. **Money** — grep \`knowledge/finance/\` for due dates within 7 days.
5. **Product** — via \`posthog\`: yesterday vs day before; flag >20% moves only.
6. **Commitments** — grep \`knowledge/\` for deadlines within 7 days.
7. **Carry-over** — read the last 2–3 files in \`outbox/briefings/\`: what was flagged then and is still unresolved today. Also note unsent drafts in \`outbox/\` and unprocessed files in \`inbox/\`.
8. **Suggested focus** — the top 3 things the user should actually do today, ranked. Weigh: everything above; working memory (active threads, recent decisions, open loops); persistence — an item ignored across briefings ranks higher, and say so ("third day waiting"); and the calendar's shape — a back-to-back day gets suggestions that fit the gaps, an open day gets the big thing, Fridays lean toward closing loops, Mondays toward starting them. One line of rationale each, tied to a concrete signal. Recommendations only — never act on them.

Compose: 2–3 sentence summary (most important thing first), then short sections: 🎯 Suggested focus · 📅 Today · ✉️ Waiting on you · 📊 Pipeline · 💶 Money · 📈 Product · ⏳ Deadlines. Every line specific and actionable. Save to \`outbox/briefings/<YYYY-MM-DD>-briefing.md\`.

The briefing is delivered as its Monad thread — don't create a Gmail draft or any email of it; the saved file is for carry-over.

Rules: read-only, never send/draft/modify. In background runs some tools may be denied — use what's allowed, say what was skipped. A quiet day = a three-line briefing.
`;

const SKILL_DRAFT_CONTRACT = `---
name: draft-contract
description: Draft a contract for a client using the company template and CRM data. Use when the user asks to "draft a contract", "prepare an agreement", or "make the contract for <client>".
---

# Draft a contract for a client

1. **Identify the client** in Twenty (company, contact, address, related deal). Ambiguous name → list matches and ask; this is a legal document.
2. **Gather terms** in priority order: the user's request → the CRM deal record → \`knowledge/clients/\` and \`knowledge/legal/\`.
3. **Fill \`templates/contract-services.md\`.** Every {{placeholder}} ends up filled or listed as an explicit **[TODO: …]** — never silently dropped, never invented. Amounts, dates, and legal names must have a citable source.
4. **Write to** \`outbox/<YYYY-MM-DD>-contract-<client-slug>.md\`.
5. **Report:** output path, filled terms with sources, TODOs for a human. Flag conflicts between recorded terms and the request instead of picking silently.
`;

const SKILL_ANALYTICS = `---
name: analytics-report
description: Pull PostHog analytics for a period and produce a readable report. Use when the user asks "how's traffic/usage", "analytics for last month", or wants a metrics summary.
---

# Analytics report from PostHog

1. **Scope the period** (user's words; default last 7 full days; always state the range).
2. **Pull via \`posthog\` MCP:** uniques, sessions/pageviews, top events vs previous period; top pages and referrers; anything specifically asked (funnel, retention, named event).
3. **Interpret, don't dump.** Explain >20% movements using \`knowledge/product/\` and \`knowledge/brand/\` (releases, campaigns) and calendar effects; separate "explained" from "worth investigating".
4. **Shape:** headline → metrics table (metric · this · previous · Δ) → notable movements → open questions.
5. Never invent numbers; small absolute counts get absolutes, not percentages.
`;

export const SKILL_BRAIN_SEARCH = `---
name: brain-search
description: Find anything in the company knowledge base or past conversations. Use when the user asks "what do we know about X", "find the document about Y", "did we agree Z with <client>", or any question answerable from recorded company knowledge.
---

# Search the company brain

1. **About a specific person, company or project?** Start with \`memory_entity\` — its page, every linked doc, related entities and CRM id in one call. \`memory_entities\` lists them (by type, or not mentioned in N days).
2. **Memory search:** \`memory_search\` — it matches by MEANING across knowledge docs AND past conversations ("payment terms" finds the doc that says "net-30"), returns excerpts with source + date. Use \`memory_session\` to read more of a conversation hit.
3. **Then the catalog:** read \`knowledge/INDEX.md\` and grep \`knowledge/\` when you need exhaustive coverage of a term or the full text of a doc.
4. **Live data** (deal status, current numbers) → also check \`twenty\`/\`posthog\` (use the entity's CRM id when it has one); note which source is newer if they disagree.
5. **Cite everything:** file paths, session titles, or tool source; quote exact figures/dates.
6. **No record → say so plainly.** Never fill gaps with plausible guesses. Fix INDEX drift when you notice it.
`;

export const SKILL_REMEMBER = `---
name: remember
description: Save, update, or forget a durable fact in working memory. Use when the user says "remember this", "note that", "don't forget", "actually it's X now", or "forget about Y" — or when they reveal a lasting preference, commitment, or open decision in passing.
---

# Remember — curate working memory

Working memory (\`knowledge/working-memory.md\`) is the small snapshot injected into EVERY session. Curate it with the \`memory_remember\` tool — never edit the file directly.

## Judgment rules (edit these as you learn what's worth keeping)

- **Declarative facts, not instructions.** "User prefers short emails" ✓ — "Always write short emails" ✗. Imperatives get re-read as directives next session.
- **Durable only.** If it will be stale in a week (task progress, "X is fixed", counts), it belongs in a knowledge doc or nowhere — not here.
- **Dedup before adding.** The snapshot is already in your context — if a fact is superseded, \`replace\` it; contradictions must not coexist.
- **Sections:** \`active-threads\` = ongoing workstreams · \`key-facts\` = stable facts & preferences · \`pending-decisions\` = open calls awaiting the user.
- **At capacity, consolidate first.** Merge related entries or drop the least valuable, then add.
- Bigger things worth keeping (documents, meeting outcomes, reference material) → ingest into \`knowledge/\` instead; working memory holds pointers, not payloads.

Writes apply from the next session. Confirm to the user in one short line what was saved/changed.
`;

const SKILL_WATCH_METRIC = `---
name: watch-metric
description: Check a metric against a threshold and alert only when it's breached. Use when the user (or a scheduled run) says "watch X", "alert me if Y drops below Z", or any threshold-check request.
---

# Watch a metric, alert on breach

1. **Parse the watch spec from the invoking prompt:** metric, threshold + direction, window (default last 7 full days). Ambiguous in a scheduled run → state the interpretation used; never silently guess a different metric.
2. **Measure** via the right source (\`posthog\` for product metrics, \`twenty\` for pipeline, \`knowledge/finance/\` for money). Note the query you ran.
3. **Breached** → \`outbox/alerts/<YYYY-MM-DD>-<metric-slug>.md\`: the number, the threshold, the two prior windows for trend, 2–3 plausible causes from \`knowledge/\`. Open with "⚠️ <metric> is <value>, below <threshold>." **Fine** → a one-line all-clear with the number.
4. Real numbers only; small counts as absolutes; say when data is missing instead of substituting.

Designed for a scheduled run, e.g.: \`Use the watch-metric skill: alert if weekly signups drop below 100.\`
`;

const CONTRACT_TEMPLATE = `# Services Agreement — Template

<!-- TODO: replace with your real contract template. Keep the {{placeholders}}. -->

**Between:** {{company_name}}, {{company_address}} ("Provider")
**And:** {{client_company}}, {{client_address}} ("Client"), represented by {{client_contact_name}}

**Effective date:** {{effective_date}}

## 1. Services
Provider will deliver: {{services_description}}

## 2. Fees & payment
Fee: {{fee}} ({{fee_terms}}). Invoicing: {{invoicing_schedule}}; payment due within {{payment_days}} days.

## 3. Term & termination
Starts on the effective date; {{term}}. Either party may terminate with {{notice_period}} written notice.

## 4. Confidentiality
Both parties keep non-public information of the other confidential during and after this agreement.

## 5. Intellectual property
{{ip_terms}}

## 6. Liability
Provider's total liability is capped at fees paid in the {{liability_window}} preceding the claim.

## 7. Governing law
{{jurisdiction}}.

---
Signatures: {{company_signatory}} — {{client_contact_name}}
`;

const EMAIL_TEMPLATE = `# Follow-up Email — Template

**Subject:** {{short, specific subject}}

Hi {{first_name}},

{{one sentence of genuine context — the last touchpoint or their situation}}

{{the point: what's pending, what we need, or what we're offering — max 3 sentences}}

{{one clear call to action with a proposed time or deadline}}

Best,
{{sender_name}}
`;

const ENV_EXAMPLE = `# Workspace credentials — copy to .env and fill in. Loaded into every agent run
# by Monad (GUI apps don't inherit shell exports). Never commit .env.

# Twenty CRM — Settings → Developers → API keys
TWENTY_BASE_URL=https://your-twenty-instance.example.com
TWENTY_API_KEY=your-twenty-api-key

# PostHog — Settings → Personal API keys
POSTHOG_PERSONAL_API_KEY=phx_your-key
`;

/** Vertical-specific "## The company" → "## Voice & tone" replacements. The
 *  shared sections (Tools, Operating rules, Knowledge conventions) come from
 *  the generic CLAUDE.md so safety rules stay identical across templates. */
const VERTICAL_INTROS: Record<string, string> = {
  agency: `## The company

- **Name:** [agency name]
- **What we do:** [design/dev/marketing agency — services, typical client, how work is priced (retainer / project / day rate)]
- **Stage & size:** [e.g. 6 people]
- **Key people:** [name — role — which clients they own]

## Clients & pipeline

- CRM is **Twenty** — source of truth for clients, deals, and tasks.
- Client work is the business: every client has a folder in \`knowledge/clients/\` (brief, scope, approvals, billing terms, sensitivities).
- [List active retainers and projects: client — scope — monthly value — day-to-day contact]
- Watch for: scope creep vs the recorded SOW, unbilled work, approval bottlenecks.

## Voice & tone

- Emails to clients: [warm, first names, concrete next steps, no agency jargon]
- Proposals/SOWs: [structure, standard terms, who signs]`,

  ecommerce: `## The company

- **Name:** [store name]
- **What we sell:** [products, channels (own store / Amazon / retail), average order value]
- **Stage & size:** [e.g. 2 founders + 3PL, ~€X monthly revenue]
- **Key people:** [name — role — what they own]

## Products & suppliers

- \`knowledge/product/\` holds per-product facts: costs, margins, suppliers, lead times, HS codes.
- \`knowledge/clients/\` is repurposed for **suppliers & partners** (terms, MOQs, contacts).
- Watch for: margin drift (costs vs recorded), stock-outs vs supplier lead times, campaign ROAS vs targets.

## Voice & tone

- Customer emails: [friendly, short, refund-generous or strict?]
- Supplier emails: [direct, quantities and dates explicit]`,

  saas: `## The company

- **Name:** [product name]
- **What we do:** [the product, who pays, pricing model (seats / usage), current MRR]
- **Stage & size:** [e.g. 3 people, bootstrapped, ~€X MRR]
- **Key people:** [name — role — what they own]

## Product & metrics

- **posthog** MCP is the source of truth for usage; \`knowledge/product/\` records pricing history, roadmap decisions, and churn post-mortems.
- \`knowledge/clients/\` holds named accounts: plan, seats, renewal date, health notes.
- Watch for: churn signals (usage drops in named accounts), trials expiring unconverted, pricing-page claims vs recorded pricing.

## Voice & tone

- Customer emails: [plain, technical honesty, no marketing fluff]
- Changelogs/announcements: [tone, cadence]`,

  consultancy: `## The company

- **Name:** [consultancy name]
- **What we do:** [advisory area, typical engagement shape and length, day rate or fixed fee]
- **Stage & size:** [e.g. solo + subcontractors]
- **Key people:** [name — role — which engagements they lead]

## Engagements & pipeline

- CRM is **Twenty** — deals are engagements; \`knowledge/clients/\` has one folder per client (proposal, scope, deliverables, rates, references given).
- Watch for: utilization vs target, proposals awaiting decision >2 weeks, deliverable deadlines, unbilled days.

## Voice & tone

- Client emails: [senior, concise, options-with-recommendation]
- Proposals: [structure, how fees are framed, validity period]`,
};

/** CLAUDE.md for a gallery template id ("generic" or unknown → the base). */
export function claudeMdForTemplate(templateId?: string): string {
  const intro = templateId ? VERTICAL_INTROS[templateId] : undefined;
  if (!intro) return CLAUDE_MD;
  // Replace everything between the H1 preamble and "## Tools" with the vertical intro.
  const toolsAt = CLAUDE_MD.indexOf("## Tools");
  const introStartAt = CLAUDE_MD.indexOf("## The company");
  if (toolsAt === -1 || introStartAt === -1) return CLAUDE_MD;
  return `${CLAUDE_MD.slice(0, introStartAt)}${intro}

${CLAUDE_MD.slice(toolsAt)}`;
}

export const SKILL_ARTIFACT = `---
name: artifact
description: Create a renderable artifact (report, dashboard, diagram, chart, formatted document) shown live in a side panel and saved to artifacts/. Use when the user asks for a dashboard, report, visualization, diagram, one-pager, or any substantial self-contained deliverable they will reuse, share, or iterate on — NOT for explanations, code snippets, or ordinary answers.
---

# Artifacts

Artifacts are self-contained deliverables rendered live in Monad's side panel and saved as real files in this workspace's \`artifacts/\` folder (openable in a browser, shareable with the team).

## When to create one — err on the side of NOT

Good artifact: substantial (roughly >15 lines), self-contained, something the user will **reuse, share, or iterate on** — a KPI dashboard, a client one-pager, an org chart, a formatted proposal.
Not an artifact: explanations, answers to questions, short snippets, code you are discussing, lists that belong in chat. When unsure, keep it in chat.

## Tools

- \`artifact_create(id, type, title, content)\` — new artifact. \`id\` is stable kebab-case (e.g. \`q3-pipeline-dashboard\`); reuse the SAME id later to edit it.
- \`artifact_update(id, old_str, new_str)\` — surgical edit. \`old_str\` must match the current content **exactly once**, including whitespace. Keep it as short as possible while still unique.
- \`artifact_rewrite(id, content, title?)\` — full replacement; use when an edit would touch a large fraction of the content, or after \`artifact_update\` failed twice.

Types: \`html\` (full page — dashboards, reports, mini-tools), \`svg\` (vector graphic), \`mermaid\` (diagram source — flowcharts, org charts, timelines), \`markdown\` (formatted document — proposals, briefs).

## Hard rules for content

1. **Complete, always.** Never placeholders, never \`<!-- rest unchanged -->\`, never a markdown fence around the content.
2. **Everything inline, zero network.** The renderer blocks ALL network access: no CDN scripts or stylesheets, no Google Fonts, no web images. Inline all CSS and JS; embed images as \`data:\` URIs. External URLs will simply fail to load.
3. **Dark-friendly.** The app is dark; give html/svg artifacts an explicit dark background and light text unless the user asks otherwise.
4. **One page.** No relative links or multi-page navigation — use in-page anchors for sections.

After the tool succeeds, the artifact is already visible — do not repeat its content in chat; one sentence about what you created is enough.
`;

/** Map of workspace-relative path → file content. */
/** System-prompt lines that amend the morning-briefing skill for every run
 *  (scheduled AND interactive). They ride the prompt rather than the skill
 *  file so settings apply without touching a user-editable file:
 *  - Delivery: the briefing IS its Monad thread. Older workspace skill copies
 *    still say "also create a Gmail draft-to-self" — and the Outbox panel
 *    lists Gmail drafts, so every morning's briefing landed there too.
 *  - Suggested focus: the per-workspace toggle in Settings → Jobs. */
export function briefingPromptRules(focusEnabled: boolean): string[] {
  const rules = [
    "Morning briefings are delivered as their Monad thread. Do NOT create a Gmail draft (or any email) of the morning briefing, even if the morning-briefing skill says to — still save the briefing file as the skill describes.",
  ];
  if (!focusEnabled) {
    rules.push(
      "The user turned OFF the briefing's Suggested focus setting — when compiling a morning briefing, omit the 🎯 Suggested focus section entirely.",
    );
  }
  return rules;
}

export const WORKSPACE_TEMPLATE: Record<string, string> = {
  "CLAUDE.md": CLAUDE_MD,
  ".mcp.json": MCP_JSON,
  ".env.example": ENV_EXAMPLE,
  "knowledge/INDEX.md": INDEX_MD,
  [WORKING_MEMORY_PATH]: workingMemoryTemplate(),
  ".claude/skills/ingest/SKILL.md": SKILL_INGEST,
  ".claude/skills/remember/SKILL.md": SKILL_REMEMBER,
  ".claude/skills/crm-status/SKILL.md": SKILL_CRM_STATUS,
  ".claude/skills/draft-contract/SKILL.md": SKILL_DRAFT_CONTRACT,
  ".claude/skills/analytics-report/SKILL.md": SKILL_ANALYTICS,
  ".claude/skills/brain-search/SKILL.md": SKILL_BRAIN_SEARCH,
  ".claude/skills/morning-briefing/SKILL.md": SKILL_BRIEFING,
  ".claude/skills/watch-metric/SKILL.md": SKILL_WATCH_METRIC,
  ".claude/skills/artifact/SKILL.md": SKILL_ARTIFACT,
  "templates/contract-services.md": CONTRACT_TEMPLATE,
  "templates/email-follow-up.md": EMAIL_TEMPLATE,
};

/** Folder names of the app-scaffolded skills above. These are part of the
 *  product (deactivatable, never deletable) — user-imported skills are
 *  anything in .claude/skills outside this set. */
export const SYSTEM_SKILL_DIRS = new Set(
  Object.keys(WORKSPACE_TEMPLATE)
    .map((p) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1])
    .filter((n): n is string => n !== undefined),
);

export const WORKSPACE_DIRS = [
  "artifacts",
  "inbox",
  "outbox",
  "templates",
  "knowledge/clients",
  "knowledge/finance",
  "knowledge/legal",
  "knowledge/product",
  "knowledge/brand",
  "knowledge/entities",
  "knowledge/notes",
  "knowledge/originals",
];

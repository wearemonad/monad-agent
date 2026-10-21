---
name: artifact
description: Create a renderable artifact (report, dashboard, diagram, chart, formatted document) shown live in a side panel and saved to artifacts/. Use when the user asks for a dashboard, report, visualization, diagram, one-pager, or any substantial self-contained deliverable they will reuse, share, or iterate on — NOT for explanations, code snippets, or ordinary answers.
---

# Artifacts

Artifacts are self-contained deliverables rendered live in Monad's side panel and saved as real files in this workspace's `artifacts/` folder (openable in a browser, shareable with the team).

## When to create one — err on the side of NOT

Good artifact: substantial (roughly >15 lines), self-contained, something the user will **reuse, share, or iterate on** — a KPI dashboard, a client one-pager, an org chart, a formatted proposal.
Not an artifact: explanations, answers to questions, short snippets, code you are discussing, lists that belong in chat. When unsure, keep it in chat.

## Tools

- `artifact_create(id, type, title, content)` — new artifact. `id` is stable kebab-case (e.g. `q3-pipeline-dashboard`); reuse the SAME id later to edit it.
- `artifact_update(id, old_str, new_str)` — surgical edit. `old_str` must match the current content **exactly once**, including whitespace. Keep it as short as possible while still unique.
- `artifact_rewrite(id, content, title?)` — full replacement; use when an edit would touch a large fraction of the content, or after `artifact_update` failed twice.

Types: `html` (full page — dashboards, reports, mini-tools), `svg` (vector graphic), `mermaid` (diagram source — flowcharts, org charts, timelines), `markdown` (formatted document — proposals, briefs).

## Hard rules for content

1. **Complete, always.** Never placeholders, never `<!-- rest unchanged -->`, never a markdown fence around the content.
2. **Everything inline, zero network.** The renderer blocks ALL network access: no CDN scripts or stylesheets, no Google Fonts, no web images. Inline all CSS and JS; embed images as `data:` URIs. External URLs will simply fail to load.
3. **Dark-friendly.** The app is dark; give html/svg artifacts an explicit dark background and light text unless the user asks otherwise.
4. **One page.** No relative links or multi-page navigation — use in-page anchors for sections.

After the tool succeeds, the artifact is already visible — do not repeat its content in chat; one sentence about what you created is enough.

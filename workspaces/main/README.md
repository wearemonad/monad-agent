# Company Brain workspace

The persistent knowledge + tooling workspace for the company. Works directly in Claude Code (`cd` here and run `claude`) and as the backend workspace for the Monad app.

## One-time setup

1. **Fill in `CLAUDE.md`** — every `[bracketed]` field. This is the company context every session starts with.
2. **Credentials** (MCP servers read them from environment variables):

   ```sh
   # e.g. in ~/.zshrc, or a .envrc if you use direnv
   export TWENTY_BASE_URL="https://<your-twenty-instance>"   # e.g. https://acme.twenty.com or your self-hosted URL
   export TWENTY_API_KEY="..."                                # Twenty → Settings → Developers → API
   export POSTHOG_PERSONAL_API_KEY="phx_..."                  # PostHog → Settings → Personal API keys
   ```

   Never commit keys to this repo.
3. **Google Drive inbox:** install Google Drive for Desktop, create a Drive folder (e.g. "Monad Inbox"), then replace `inbox/` with a symlink to it:

   ```sh
   rmdir inbox && ln -s "$HOME/Library/CloudStorage/GoogleDrive-<account>/My Drive/Monad Inbox" inbox
   ```

   Anything dropped into that Drive folder (from any device) lands in `inbox/`, ready for the `ingest` skill.
4. **Templates:** replace the skeletons in `templates/` with your real contract and email templates (keep the `{{placeholders}}`).

## Layout

- `CLAUDE.md` — company identity, tone, operating rules (loaded into every session)
- `.mcp.json` — Twenty CRM (its official `/mcp` server) + PostHog MCP servers
- `.claude/skills/` — ingest · crm-status · draft-contract · analytics-report · brain-search
- `inbox/` — file dump (Drive-synced); processed by `ingest`
- `knowledge/` — the brain: processed markdown docs + `INDEX.md` catalog + archived `originals/`
- `templates/` — contract & email templates
- `outbox/` — generated drafts for human review; nothing is ever sent automatically

## Daily use

- Drop files in the Drive inbox → say "ingest" (or the Monad app triggers it on file-drop).
- "What's the CRM status?" → pipeline report + follow-up email drafts in `outbox/`.
- "Draft a contract for Acme" → filled template in `outbox/` with sourced terms and TODOs.
- "Analytics for June?" → PostHog report.
- "What do we know about X?" → cited answers from `knowledge/`.

## New company?

Copy this workspace, empty `knowledge/` and `outbox/`, rewrite `CLAUDE.md` and `templates/`, point `.mcp.json` env vars at the new company's accounts.

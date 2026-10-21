# Monad Agent — a Claude brain for your business

Monad Agent is a macOS app that turns a folder into a company brain. Drop in contracts, notes, invoices and exports; Monad Agent files them into a searchable knowledge base, and a Claude agent works on top of it — answering with citations, drafting emails and contracts, reading your CRM and analytics, and running scheduled jobs like a morning briefing.

Everything stays on your Mac. The brain is a plain folder of Markdown files, so it also works directly in [Claude Code](https://claude.com/claude-code).

> **Status:** early and moving fast. macOS on Apple Silicon only.

## Features

- **Workspaces** — one brain per company or client, each with its own knowledge, chats, credentials and connected accounts.
- **Ingest** — drag files into the app (or sync a Google Drive folder) and the agent turns them into structured, linked Markdown under `knowledge/`, with an `INDEX.md` catalog. Changes wait in a review queue before they land.
- **Memory & search** — a local hybrid index (SQLite FTS5 + on-device embeddings) with cited results, a small working memory injected into every run, and a derived knowledge graph of people, companies and projects.
- **Artifacts** — HTML, SVG, Mermaid and Markdown documents rendered in a sandboxed side panel, with version history.
- **Google** — per-workspace Gmail (search, read, drafts — the agent can never send), Calendar, and Drive folder sync.
- **Connectors** — any MCP server, configured per workspace from Settings (Twenty CRM and PostHog are pre-wired in the template).
- **Scheduled jobs** — morning briefings and recurring reports that run in the background with tighter permissions than interactive chats.
- **Permissions** — every tool call that writes or reaches out asks first; per-workspace "always allow" rules for the ones you trust.
- **Models** — Claude via your Claude Code login or an Anthropic API key, OpenAI via Codex, or local models via Ollama.

## Install

Download the latest signed build from [Releases](../../releases), open the `.dmg`, and drag Monad Agent to Applications. Official builds update themselves and come with Google sign-in built in.

Then, in Monad Agent:

1. **Settings → Providers** — sign in to Claude (see [Auth modes](#auth-modes)).
2. **Settings → Workspaces → Create new workspace** — scaffolds a brain folder from the built-in template.
3. Fill in the workspace's `CLAUDE.md` (company context, tone, rules). The brain is only as good as this file.
4. Optional: **Connect Google account** on the workspace, and add connector credentials under **Settings → Connectors**.

## Build from source

Requirements: macOS 14+ on Apple Silicon, [Bun](https://bun.sh) 1.3+, Xcode Command Line Tools, and [Claude Code](https://claude.com/claude-code) installed and logged in (or an Anthropic API key).

```sh
git clone https://github.com/wearemonad/monad-agent.git
cd monad-agent/app
bun install            # also runs `electrobun sync` to fetch the toolchain
bun run start          # build the UI and launch the app in dev mode
```

Other commands (run in `app/`):

| Command | What it does |
| --- | --- |
| `bun run dev` | Dev mode with renderer hot reload (Vite on :5173) and bun-side `--watch` |
| `bun test src` | Unit tests |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build:canary` | Packaged `.app` + `.dmg` in `app/build/` and `app/artifacts/` |
| `bun run lint` (repo root) | Biome lint + format check |

Source builds have **no built-in Google client** and **no update feed**. To use Gmail, Calendar or Drive, create your own Google OAuth client (about 10 minutes) and paste it into **Settings → Google** — see [docs/google-oauth.md](docs/google-oauth.md).

Unsigned builds need a one-time **right-click → Open** on first launch (Gatekeeper). To sign, notarize and publish updates for your own distribution, see [docs/releasing.md](docs/releasing.md).

## Auth modes

Monad Agent never proxies anyone's account through a server. Each person authenticates on their own machine.

- **Claude subscription (default)** — drives your locally installed, logged-in Claude Code binary, using your Pro/Max plan. Monad Agent finds `claude` automatically (`~/.local/bin`, Homebrew, or your login-shell `PATH`); override with `MONAD_CLAUDE_BIN`. Note: Anthropic's terms restrict using consumer subscriptions outside its own apps. Driving the genuine local CLI currently works, but it is not an officially sanctioned integration and may stop working. If that matters to you, use an API key.
- **Anthropic API key** — the Agent SDK's bundled runtime with your key (stored in the macOS Keychain). Pay per token; fully sanctioned.
- **Local (Ollama)** — run background work such as ingest and summaries on a local model.
- **OpenAI (Codex)** — OpenAI models through the Codex SDK, with your own Codex login.

Never share one subscription across people or put Monad Agent behind a server.

## Workspaces

A workspace is a folder:

```
CLAUDE.md          company identity, tone, operating rules — loaded into every run
.mcp.json          MCP connectors (Twenty, PostHog, your own), ${VAR} placeholders
.claude/skills/    ingest · brain-search · crm-status · draft-contract · morning-briefing · …
inbox/             files waiting to be ingested
knowledge/         the brain: processed Markdown, INDEX.md, entities/, originals/
templates/         contract and email templates
outbox/            drafts for human review — nothing is ever sent automatically
.monad/            per-machine state: search index, sync ledgers (never share or commit)
```

[`workspaces/main/`](workspaces/main/) is an example brain you can open in the app or use directly in Claude Code (`cd workspaces/main && claude`).

**Credentials** for connectors are entered in **Settings → Connectors** and stored in the macOS Keychain, per workspace. For development you can also put them in a workspace `.env` (see `.env.example`).

**Sharing with a team:** make the workspace folder a private git repo. Keep `.env`, `.monad/`, `inbox/`, `outbox/` and `knowledge/originals/` out of it. Don't share a workspace through Drive or Dropbox folder sync — `.monad/` holds per-machine databases and raw conversation logs that must not leave the machine.

## Architecture

Monad Agent is built with [Electrobun](https://github.com/blackboardsh/electrobun): a Bun main process plus a native WebKit webview.

- `app/src/bun/` — the main process owns everything: `AgentService` (Claude Agent SDK lifecycle → normalized stream events), `PermissionBroker` (tool approvals), `WorkspaceManager`, `SessionStore`, `SchedulerService`, `MemoryIndexService`, Google services, and auth strategies. Built on [Effect](https://effect.website).
- `app/src/mainview/` — the React UI (Tailwind, shadcn/ui on Base UI, Zustand). It never touches the SDK; it talks to the bun process over typed RPC.
- `app/src/shared/` — the contract both sides compile against (`ipc.ts`) plus shared pure logic.

## Privacy

Monad Agent has no backend and no telemetry. Your files, index and chats stay on your Mac; credentials and OAuth tokens live in the macOS Keychain. Content you work with is sent to the model provider you choose (Anthropic, OpenAI, or nothing when running locally) and to the services you connect.

## Contributing

Issues and pull requests are welcome — see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). To report a security issue privately, see [docs/SECURITY.md](docs/SECURITY.md).

## License

[Apache License 2.0](LICENSE). Copyright © 2026 Pixel Bucket Ltd, trading as We Are Monad.

We Are Monad® is a registered trademark of Pixel Bucket Ltd. The license covers the code, not the name or logo — if you distribute a fork, please give it your own name and icon.

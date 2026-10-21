# Signing, releases and auto-updates

For maintainers publishing official builds, and for anyone distributing their own fork.

## 1. How updates work

Monad uses Electrobun's built-in differential updater. Installed apps check `<baseUrl>/<channel>-macos-arm64-update.json` 15 seconds after launch and every 4 hours. When the manifest's content hash differs from the running build, the sidebar shows "Update available" and macOS posts a notification. Installing is always a click (**Settings → Download & install**): a few-KB bsdiff patch chain is applied when available, otherwise the full bundle is downloaded, then the app relaunches.

- **Channels** — `canary` and `stable` have independent manifests; a build stays on the channel it was built for. Dev builds never update.
- **Data survives** — only the `.app` is replaced. Workspaces are folders, credentials are in the Keychain, app state is in `~/Library/Application Support/Monad/`.
- **Source builds** without `MONAD_UPDATE_BASE_URL` show "Updates not configured" and never poll.

## 2. Distributing your own fork

Official builds only update from the official feed. If you ship your own build, give it its own identity so it can't collide with — or be updated by — the official app:

1. In `app/electrobun.config.ts`, change `app.identifier` (e.g. `com.yourcompany.monad`) and, if you like, `app.name`.
2. Use your own update bucket ([§4](#4-update-hosting-cloudflare-r2-10-minutes)), your own signing identity ([§3](#3-code-signing-and-notarization)) and your own Google client ([google-oauth.md](google-oauth.md)).

## 3. Code signing and notarization

Unsigned builds work but need a one-time **right-click → Open** on every Mac that didn't build them. To sign, you need an Apple Developer account with a **Developer ID Application** certificate in your login keychain. Then:

```sh
cd app
cp .env.example .env     # .env is gitignored — never commit it
# ELECTROBUN_DEVELOPER_ID="Developer ID Application: Your Company Ltd (TEAMID1234)"
# ELECTROBUN_APPLEID=you@example.com
# ELECTROBUN_APPLEIDPASS=<app-specific password from appleid.apple.com>
# ELECTROBUN_TEAMID=TEAMID1234
```

Codesigning and notarization switch on automatically when these are set. Notarization adds roughly five minutes per build while Apple scans it.

## 4. Update hosting (Cloudflare R2, ~10 minutes)

Any static HTTPS host works. R2 is the default because egress is free and the free tier covers a project this size.

1. Create a Cloudflare account, activate **R2 Object Storage** in the dashboard, then run `bunx wrangler login`.
2. Create a public bucket:

   ```sh
   bunx wrangler r2 bucket create monad-updates
   bunx wrangler r2 bucket dev-url enable monad-updates   # → https://pub-<id>.r2.dev
   ```

   A custom domain (bucket → Settings → Custom Domains) can replace the `r2.dev` URL later — change the env var and rebuild.
3. In `app/.env`:

   ```
   MONAD_UPDATE_BASE_URL=https://pub-<id>.r2.dev
   R2_BUCKET=monad-updates     # optional; this is the default
   ```

> The base URL is baked into each build. A build published without it can never update — everyone on it has to install the next release by hand once. `release.sh` refuses to publish in that case.

## 5. Shipping a release

An official release needs all of the following in `app/.env`: the `ELECTROBUN_*` signing credentials, `MONAD_UPDATE_BASE_URL`, and `MONAD_GOOGLE_CLIENT_ID` / `MONAD_GOOGLE_CLIENT_SECRET`. Plus `gh auth login` for the GitHub release.

```sh
cd app
./release.sh canary                 # patch bump (0.1.0 → 0.1.1) → build → publish
./release.sh stable minor           # minor bump on the stable channel
./release.sh canary 0.7.0           # explicit version
./release.sh canary none            # re-publish the current version
./release.sh canary --allow-dirty   # skip the clean-tree check (WIP canary)
./release.sh canary --no-release    # publish the update, skip the GitHub release
```

The script:

1. Refuses to run on a dirty tree (so each build maps to a commit) or while a dev session is running.
2. Bumps the version in `app/electrobun.config.ts` and `app/package.json`, then builds.
3. Verifies the build before uploading anything: update URL baked in, built-in Google client baked in, Developer ID signed and notarized.
4. Uploads bundles and patches to R2, then the manifest **last** — the manifest flips the release live, so a half-finished upload never breaks anyone.
5. Commits the version bump, pushes, and creates a GitHub release with the `.dmg` attached. `stable` tags `vX.Y.Z`; `canary` tags `vX.Y.Z-canary` as a prerelease.

> Keep `app/artifacts/` from the previous release in place — it's the diff base for patch generation. Losing it is harmless; the next update is just a full download instead of a few KB.

**Routine:** ship to `canary`, use it for a day, then `./release.sh stable`. Roll back by re-publishing the previous code under a new version — the newest manifest wins.

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Updates not configured" in Settings | Built without `MONAD_UPDATE_BASE_URL`. Set it, rebuild, redistribute once. |
| "Updates disabled in dev builds" | You're running `electrobun dev`. Only packaged channel builds update. |
| "Already on latest" right after publishing | Check `curl <baseUrl>/canary-macos-arm64-update.json` shows the new hash (CDN cache). |
| Full-bundle download instead of a patch | The previous `artifacts/` wasn't present at build time. Harmless. |
| wrangler auth errors | Run `bunx wrangler login` again, or set `CLOUDFLARE_API_TOKEN`. |
| The build hangs at `electrobun sync` | A dev session is running in the same folder. Stop it first. |

#!/usr/bin/env bash
# Monad release script — bump the version, build, and publish an update to Cloudflare R2.
#
#   ./release.sh canary          # your channel, patch bump (0.1.0 → 0.1.1)
#   ./release.sh stable minor    # teammates' channel, minor bump (0.1.1 → 0.2.0)
#   ./release.sh canary 0.5.0    # set an explicit version
#   ./release.sh canary none     # re-publish the current version without bumping
#   ./release.sh canary --allow-dirty   # skip the clean-tree check (WIP canary)
#
# The version is bumped in app/electrobun.config.ts (the source of truth the app
# displays) and kept in sync in app/package.json.
#
# Refuses to run on a dirty git tree by default (so the version bump is the only
# uncommitted change and each build maps to a known commit). Override with
# --allow-dirty or ALLOW_DIRTY=1.
#
# After building + uploading to R2 it also cuts a GitHub release: commits the
# version bump (only the two version files), pushes origin/HEAD, then creates a
# tagged release with the .dmg + bundle attached. stable → tag vX.Y.Z; canary →
# vX.Y.Z-canary (marked prerelease). Skip with --no-release. Needs the gh CLI,
# authenticated, with an "origin" remote. With several gh accounts logged in,
# the release uses the account that owns the origin repo (not whichever is
# active); set GH_ACCOUNT=<login> or GH_TOKEN to choose another.
#
# Requirements (one-time): `bunx wrangler login`, `gh auth login`, bucket created (see docs/releasing.md),
# MONAD_UPDATE_BASE_URL set in app/.env, R2_BUCKET below matching your bucket name.
#
# IMPORTANT: keep the artifacts/ folder from the previous release in place before
# building — that's what lets Electrobun generate few-KB bsdiff patches.

set -euo pipefail
cd "$(dirname "$0")"

USAGE="Usage: ./release.sh [canary|stable] [patch|minor|major|X.Y.Z|none] [--allow-dirty] [--no-release]"

ALLOW_DIRTY_FLAG=0
DO_RELEASE=1
POSITIONAL=()
for arg in "$@"; do
	case "$arg" in
		--allow-dirty) ALLOW_DIRTY_FLAG=1 ;;
		--no-release|--no-github) DO_RELEASE=0 ;;
		-h|--help) echo "$USAGE"; exit 0 ;;
		*) POSITIONAL+=("$arg") ;;
	esac
done

CHANNEL="${POSITIONAL[0]:-canary}"
BUMP="${POSITIONAL[1]:-patch}"
R2_BUCKET="${R2_BUCKET:-monad-updates}"

if [[ "$CHANNEL" != "canary" && "$CHANNEL" != "stable" ]]; then
	echo "$USAGE" >&2
	exit 1
fi

# electrobun.config.ts reads release.baseUrl (MONAD_UPDATE_BASE_URL) and the
# signing/notarization creds (ELECTROBUN_*) from process.env. Electrobun 1 loaded
# app/.env itself; Electrobun 2 (Hutch) does NOT — so export app/.env into this
# shell, which the build inherits. Without this, builds ship with baseUrl "" (can
# never update) and ad-hoc signed — v0.4.0–v0.5.0 shipped that way.
# .env is dotenv syntax, not bash (unquoted values like "Developer ID
# Application: Name (TEAMID)" break `source`), so let Bun parse it — it loads
# ./.env natively — and hand back the keys the file defines, NUL-separated.
if [[ -f .env ]]; then
	while IFS= read -r -d '' kv; do
		export "$kv"
	done < <(bun -e '
		const text = await Bun.file(".env").text();
		for (const [, key] of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/gm)) {
			const value = process.env[key];
			if (value !== undefined) process.stdout.write(`${key}=${value}\0`);
		}
	')
fi
if [[ -z "${MONAD_UPDATE_BASE_URL:-}" ]]; then
	echo "⚠️  MONAD_UPDATE_BASE_URL is not set in app/.env — the build will not be" >&2
	echo "    update-capable. Set it first (see docs/releasing.md), then re-run." >&2
	exit 1
fi
if [[ -z "${MONAD_GOOGLE_CLIENT_ID:-}" || -z "${MONAD_GOOGLE_CLIENT_SECRET:-}" ]]; then
	echo "⚠️  MONAD_GOOGLE_CLIENT_ID / MONAD_GOOGLE_CLIENT_SECRET are not set in app/.env —" >&2
	echo "    the release would ship without a built-in Google client, and every user" >&2
	echo "    would have to bring their own. Set them (see docs/google-oauth.md)." >&2
	exit 1
fi

# --- Refuse on a dirty working tree -----------------------------------------
# The script edits tracked files (the version bump), so a release should start
# from a clean tree: that keeps the bump the only uncommitted change and ties
# every published build to a known commit. Override for WIP canary builds with
# --allow-dirty (or ALLOW_DIRTY=1). Build outputs (build/ dist/ artifacts .env)
# are gitignored, so they never count as "dirty".
if [[ "${ALLOW_DIRTY:-0}" != "1" && "$ALLOW_DIRTY_FLAG" != "1" ]]; then
	if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		if [[ -n "$(git status --porcelain)" ]]; then
			echo "✋ Working tree is dirty — commit or stash first, or pass --allow-dirty." >&2
			echo "   A clean tree keeps the version bump isolated and ties this build to a commit." >&2
			git status --short >&2
			exit 1
		fi
	else
		echo "⚠️  Not a git repository — skipping the clean-tree check." >&2
	fi
fi

# --- Refuse while a dev session runs in this folder -------------------------
# Since Electrobun 2, `electrobun dev --watch` (bun dev) holds a reader lease in
# .hutch/locks/electrobun-readers/ for as long as it runs, and `electrobun sync`
# below waits for every lease to go — silently, forever. Check before the
# version bump so a refused run leaves nothing behind.
DEV_PIDS="$(lsof -t .hutch/locks/electrobun-readers/*.lease 2>/dev/null | sort -u | tr '\n' ' ' || true)"
if [[ -n "${DEV_PIDS// /}" ]]; then
	echo "✋ An Electrobun dev session (bun dev) is running in this folder — pid ${DEV_PIDS% }." >&2
	echo "   The build's 'electrobun sync' step would wait on it forever. Stop bun dev" >&2
	echo "   (Ctrl-C in its terminal), then re-run." >&2
	exit 1
fi

# --- Version bump ------------------------------------------------------------
# electrobun.config.ts is the source of truth the app reads; package.json is
# kept in lockstep so tooling/humans never see a mismatch.
CONFIG="electrobun.config.ts"
PKG="package.json"

CURRENT=$(grep -oE 'version:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' "$CONFIG" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
if [[ -z "${CURRENT:-}" ]]; then
	echo "⚠️  Could not read current version (version: \"x.y.z\") from $CONFIG" >&2
	exit 1
fi

if [[ "$BUMP" == "none" ]]; then
	NEW="$CURRENT"
elif [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	NEW="$BUMP"
else
	IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
	case "$BUMP" in
		major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
		minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
		patch) PATCH=$((PATCH + 1)) ;;
		*) echo "$USAGE" >&2; exit 1 ;;
	esac
	NEW="${MAJOR}.${MINOR}.${PATCH}"
fi

if [[ "$NEW" != "$CURRENT" ]]; then
	echo "▶ Bumping version ${CURRENT} → ${NEW}"
	# Replace only the first version:/"version": occurrence (the app version), leaving deps untouched.
	perl -0pi -e 's/(\bversion:\s*")[0-9]+\.[0-9]+\.[0-9]+(")/${1}'"$NEW"'${2}/' "$CONFIG"
	perl -0pi -e 's/("version":\s*")[0-9]+\.[0-9]+\.[0-9]+(")/${1}'"$NEW"'${2}/'  "$PKG"
else
	echo "▶ Keeping version ${CURRENT} (no bump)"
fi

VERSION="$NEW"

echo "▶ Building Monad v${VERSION} (${CHANNEL})…"
# Electrobun 2: the SDK that vite.config.ts and the build resolve lives in the
# Hutch devkit (.hutch/devkit), projected by sync. Hash-verified; a no-op when
# already current.
bunx electrobun sync
bunx vite build
bunx electrobun build --env="$CHANNEL"

# --- Verify the build can update ---------------------------------------------
# The baseUrl baked into version.json is what the installed app polls. If it's
# empty, publishing would strand everyone who installs this build — they'd
# never see another update. Check before anything is uploaded.
# canary/stable builds are self-extracting: build/…/<app>.app is only a launcher
# wrapper, and the real app (with version.json) is packed in the artifacts
# tarball — the same tarball the updater and the .dmg install.
TARBALL="$(ls artifacts/"${CHANNEL}"-macos-arm64-*.app.tar.zst 2>/dev/null | head -1)"
BAKED_URL="$(zstd -dc "$TARBALL" 2>/dev/null | tar -xOf - '*.app/Contents/Resources/version.json' 2>/dev/null |
	grep -oE '"baseUrl":"[^"]*"' | sed -E 's/"baseUrl":"(.*)"/\1/' || true)"
if [[ -z "$BAKED_URL" ]]; then
	echo "✋ The built app in ${TARBALL:-artifacts/} has no baseUrl — it would never" >&2
	echo "   receive updates. Not publishing. Check MONAD_UPDATE_BASE_URL / electrobun.config.ts." >&2
	exit 1
fi
echo "▶ Build polls ${BAKED_URL} for updates"

# The built-in Google client is a bundler `define` — if it didn't take, users
# would land on "no built-in Google client". The tar stream is uncompressed, so
# a plain byte search finds the baked id wherever the bundle put it.
# Not `grep -q`: it exits on the first match, zstd dies of SIGPIPE (141), and
# pipefail turns that into a failed check even though the id is there. Plain
# grep reads to the end, so zstd always finishes.
if ! zstd -dc "$TARBALL" 2>/dev/null | grep -aF "$MONAD_GOOGLE_CLIENT_ID" >/dev/null; then
	echo "✋ The built app has no built-in Google client baked in. Not publishing." >&2
	echo "   Check MONAD_GOOGLE_CLIENT_ID and the define in electrobun.config.ts." >&2
	exit 1
fi
echo "▶ Build ships the built-in Google client"

# Same failure mode for signing: without the ELECTROBUN_* creds the build is
# only ad-hoc signed and Gatekeeper blocks it on teammates' Macs. spctl accepts
# only a Developer ID signed + notarized app (the launcher wrapper is what the
# .dmg ships and what Gatekeeper sees).
APP_BUNDLE="$(ls -d build/"${CHANNEL}"-macos-arm64/*.app 2>/dev/null | head -1)"
if ! spctl -a -vv "$APP_BUNDLE" 2>&1 | grep "source=Notarized Developer ID" >/dev/null; then
	echo "✋ ${APP_BUNDLE:-the build} is not Developer ID signed + notarized — not publishing." >&2
	echo "   Check the ELECTROBUN_* signing/notarization creds in app/.env." >&2
	exit 1
fi
echo "▶ Build is Developer ID signed and notarized"

ART="artifacts"
MANIFEST="${CHANNEL}-macos-arm64-update.json"

echo "▶ Uploading artifacts to r2://${R2_BUCKET}…"
# Everything except the manifest first — the manifest is the pointer that flips
# the release live, so it must land last.
for f in "$ART"/*; do
	name=$(basename "$f")
	[[ "$name" == "$MANIFEST" ]] && continue
	echo "  ↑ $name"
	bunx wrangler r2 object put "${R2_BUCKET}/${name}" --file "$f" --remote
done

echo "  ↑ $MANIFEST (flips the release live)"
bunx wrangler r2 object put "${R2_BUCKET}/${MANIFEST}" --file "$ART/$MANIFEST" --remote

# --- GitHub release ----------------------------------------------------------
# Runs only after R2 is fully published, so nothing hits GitHub until the update
# is live. stable → vX.Y.Z; canary → vX.Y.Z-canary (prerelease).
if [[ "$DO_RELEASE" == "1" ]]; then
	if [[ "$CHANNEL" == "canary" ]]; then
		TAG="v${VERSION}-canary"; PRERELEASE="--prerelease"
	else
		TAG="v${VERSION}"; PRERELEASE=""
	fi

	if ! command -v gh >/dev/null 2>&1; then
		echo "⚠️  gh CLI not installed — skipping GitHub release (R2 publish is done)." >&2
	elif ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		echo "⚠️  Not a git repository — skipping GitHub release." >&2
	else
		# gh's ACTIVE account may not be the one that can see this repo (several
		# accounts logged in) — every gh call then 404s ("HTTP 404: Not Found
		# …/releases"). Use the token of the account that owns the origin repo
		# (override with GH_ACCOUNT=<login>), for this script only: the user's
		# active gh account is left alone. An explicit GH_TOKEN wins. If the
		# owner isn't a logged-in account (an org repo such as wearemonad/…),
		# the first logged-in account with push access to the repo is used.
		if [[ -z "${GH_TOKEN:-}" ]]; then
			ORIGIN_REPO="$(git remote get-url origin |
				sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
			GH_ACCOUNT="${GH_ACCOUNT:-${ORIGIN_REPO%%/*}}"
			if GH_ACCOUNT_TOKEN="$(gh auth token --user "$GH_ACCOUNT" 2>/dev/null)" &&
				[[ -n "$GH_ACCOUNT_TOKEN" ]]; then
				export GH_TOKEN="$GH_ACCOUNT_TOKEN"
				echo "▶ Using gh account ${GH_ACCOUNT} for the GitHub release"
			else
				for login in $(gh auth status 2>&1 |
					sed -nE 's/.*Logged in to github\.com account ([^ ]+).*/\1/p'); do
					token="$(gh auth token --user "$login" 2>/dev/null)" || continue
					if [[ "$(GH_TOKEN="$token" gh api "repos/${ORIGIN_REPO}" \
						--jq .permissions.push 2>/dev/null)" == "true" ]]; then
						export GH_TOKEN="$token"
						echo "▶ Using gh account ${login} for the GitHub release"
						break
					fi
				done
			fi
		fi

		# Commit the bump — stage ONLY the two version files, so a --allow-dirty run
		# never sweeps unrelated WIP into the release commit. Keyed on the files
		# having changes, not on NEW != CURRENT, so re-running with `none` after a
		# run that bumped but failed later (bump left uncommitted) still commits it.
		if ! git diff --quiet HEAD -- "$CONFIG" "$PKG"; then
			git add "$CONFIG" "$PKG"
			git commit -q -m "release: ${TAG}"
			echo "▶ Committed version bump (${TAG})"
		fi

		echo "▶ Pushing to origin…"
		git push -q origin HEAD

		# Release notes: --generate-notes only lists merged PRs, and this repo
		# pushes straight to main, so GitHub produced empty notes. Build them
		# from history instead: every commit since the previous release tag
		# (any channel — canary and stable interleave on main), minus the
		# release: bumps themselves. Falls back to --generate-notes on the
		# first-ever release (no previous tag to diff against).
		# gh release create makes its tag on GitHub only — fetch tags first or
		# describe would diff against whatever old tag exists locally.
		git fetch -q origin --tags 2>/dev/null || true
		PREV_TAG="$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)"
		NOTES=""
		if [[ -n "$PREV_TAG" ]]; then
			NOTES="$(git log --no-merges --grep='^release:' --invert-grep \
				--pretty='- %s (%h)' "${PREV_TAG}..HEAD")"
			[[ -z "$NOTES" ]] && NOTES="No code changes since ${PREV_TAG} (re-publish)."
			REPO_URL="$(gh repo view --json url --jq .url 2>/dev/null || true)"
			[[ -n "$REPO_URL" ]] && NOTES="${NOTES}"$'\n\n'"**Full changelog**: ${REPO_URL}/compare/${PREV_TAG}...${TAG}"
		fi

		# Attach this channel's installer + bundle.
		shopt -s nullglob
		ASSETS=("$ART"/${CHANNEL}-*.dmg "$ART"/${CHANNEL}-*.app.tar.zst)
		shopt -u nullglob
		[[ ${#ASSETS[@]} -eq 0 ]] && echo "⚠️  No .dmg/.tar.zst for ${CHANNEL} in $ART/ — releasing without assets." >&2

		HEAD_SHA="$(git rev-parse HEAD)"
		if [[ -n "$NOTES" ]]; then
			NOTES_ARGS=(--notes "$NOTES")
		else
			NOTES_ARGS=(--generate-notes)
		fi

		if gh release view "$TAG" >/dev/null 2>&1; then
			echo "▶ Updating existing GitHub release ${TAG}"
			[[ -n "$NOTES" ]] && gh release edit "$TAG" --notes "$NOTES" >/dev/null
			[[ ${#ASSETS[@]} -gt 0 ]] && gh release upload "$TAG" "${ASSETS[@]}" --clobber
		else
			echo "▶ Creating GitHub release ${TAG}"
			if [[ ${#ASSETS[@]} -gt 0 ]]; then
				gh release create "$TAG" $PRERELEASE --title "Monad ${VERSION} (${CHANNEL})" \
					"${NOTES_ARGS[@]}" --target "$HEAD_SHA" "${ASSETS[@]}"
			else
				gh release create "$TAG" $PRERELEASE --title "Monad ${VERSION} (${CHANNEL})" \
					"${NOTES_ARGS[@]}" --target "$HEAD_SHA"
			fi
		fi
		echo "🏷  GitHub release ${TAG}: $(gh release view "$TAG" --json url --jq .url 2>/dev/null || echo done)"
	fi
fi

echo "✅ v${VERSION} published to ${CHANNEL}. Apps pick it up on their next check."

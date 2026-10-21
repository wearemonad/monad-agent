# Google OAuth setup

How "Connect Google account" works, how to bring your own Google client, and how official builds ship one.

## 1. How it works

Each workspace connects its own Google account (Drive, Gmail, Calendar). Monad uses the standard native-app flow — OAuth 2.0 with PKCE and a loopback redirect on `127.0.0.1`. The refresh token goes into your macOS Keychain, keyed per workspace. Nothing touches a server; disconnecting or removing a workspace deletes its tokens.

An OAuth *client* is the app's identity with Google, not yours. There are two ways Monad gets one:

| Build | Google client | What you do |
| --- | --- | --- |
| Official release (signed `.dmg` from GitHub Releases) | Built in, baked in at build time | Nothing — click **Connect Google account**. |
| Built from source, or a fork | None | Create your own client ([§2](#2-bring-your-own-client-10-minutes)) and paste it into **Settings → Google → OAuth client**. |

Any build can override the built-in client in **Settings → Google**. Leave both fields empty and save to fall back to the built-in one.

## 2. Bring your own client (~10 minutes)

Do this in any Google account you control. It is unrelated to which accounts you later connect.

1. **Project and APIs.** At [console.cloud.google.com](https://console.cloud.google.com/), create a project (e.g. "Monad"). Under **APIs & Services → Library**, enable the **Google Drive API**, **Gmail API** and **Google Calendar API**.
2. **Branding and audience.** Open **Google Auth Platform** (APIs & Services → OAuth consent screen). Set the app name and support email. Pick an audience:
   - **Internal** — only if your account is on **Google Workspace** and only people in your organization will connect. No verification, no warning screen, no user cap. *Best choice for companies.*
   - **External** — for personal Gmail accounts. See [§3](#3-publishing-status-and-verification) for what this means.
3. **Scopes** (sidebar → **Data Access** → Add or remove scopes → "Manually add scopes"):

   ```
   https://www.googleapis.com/auth/drive.readonly
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.compose
   https://www.googleapis.com/auth/calendar.events
   openid
   ```

   The picker only lists scopes of APIs you've enabled, so do step 1 first. Gmail and Drive land under "Restricted scopes" — that's expected.
4. **External only — test users or publish.** Either add every Google account that will connect under **Audience → Test users** (up to 100), or click **Publish app** (see [§3](#3-publishing-status-and-verification)).
5. **The client.** **Clients → Create client → Application type: Desktop app**. Copy the **Client ID** and **Client secret**.
6. In Monad: **Settings → Google → OAuth client**, paste both, **Save**. The secret goes to your Keychain. Then connect an account from **Settings → Workspaces**.

## 3. Publishing status and verification

Gmail and Drive scopes are *restricted* in Google's terms. For an **External** client, that decides how the consent screen behaves:

| Status | Behaviour | Good for |
| --- | --- | --- |
| **Testing** | Only listed test users (≤100) can connect. Refresh tokens **expire after 7 days**, so each workspace needs reconnecting weekly. | Trying it out. |
| **In production, unverified** | Tokens don't expire. Users see a "Google hasn't verified this app" screen once (**Advanced → Go to …**). Limited to **100 users in total**. | Yourself, a small team. |
| **Verified** | No warning, no cap. Requires brand verification and — for restricted scopes — an annual third-party CASA security assessment. | Broad public distribution. |

> **Using your own client for yourself or your team?** On Google Workspace, use **Internal** and you skip all of this. On personal Gmail, publish the app unverified — the one-time warning is about *your own* client, so you know who you're trusting.

## 4. Official builds (maintainers)

Release builds bake a client in at build time; it is never committed to source. In `app/.env`:

```
MONAD_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
MONAD_GOOGLE_CLIENT_SECRET=GOCSPX-…
```

`electrobun.config.ts` injects these via the bundler's `define`, and `release.sh` refuses to publish without them. Per Google's documentation, desktop-app client secrets are not treated as confidential (PKCE protects the flow), but keeping them out of source means forks don't run on — and use up the user cap of — the official project.

## 5. What the agent can do once connected

| Tool | Capability | Guardrail |
| --- | --- | --- |
| `gmail_search`, `gmail_read` | Find and read mail | Read-only scope |
| `gmail_create_draft` | Create drafts for review | The agent cannot send. Sending is a human click on a draft card. |
| `calendar_list_events`, `calendar_create_event` | Read the week, book meetings | Creating events asks for permission |
| Drive folder sync | A chosen folder fills the workspace inbox every 5 minutes | Read-only scope, one folder per workspace |

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "This build of Monad has no built-in Google client" | You're on a source build. Add your own client ([§2](#2-bring-your-own-client-10-minutes)). |
| "Access blocked: … has not completed the Google verification process" | Testing mode and the account isn't a test user. Add it, or publish the app ([§3](#3-publishing-status-and-verification)). |
| Connection stops working after about a week | Still in Testing → 7-day token expiry. Publish the app, then reconnect once. |
| "Google hasn't verified this app" | Expected for unverified production clients: **Advanced → Go to …**, once per account. |
| Asked to reconnect after an update | Monad's scopes changed; new scopes need fresh consent. Disconnect and reconnect on the workspace. |

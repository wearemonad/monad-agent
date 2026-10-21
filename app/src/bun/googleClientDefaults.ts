/** Monad's built-in Google OAuth client — the app's identity with Google,
 *  shipped inside official builds so end users just click "Connect Google
 *  account" and see a normal consent screen.
 *
 *  The values are NOT in source. Official releases bake them in at build time
 *  (electrobun.config.ts `define`s MONAD_GOOGLE_CLIENT_ID / _SECRET from
 *  app/.env, which release.sh exports). Builds from source without them simply
 *  have no built-in client: Settings → Google then asks for your own
 *  "Desktop app" client — see docs/google-oauth.md.
 *
 *  Per Google's OAuth docs, desktop client secrets are not treated as
 *  confidential (PKCE protects the flow); they stay out of source so forks
 *  don't run on — and count against the user cap of — someone else's Google
 *  project. Users' refresh tokens live only in each user's macOS Keychain,
 *  scoped per workspace.
 */
export const GOOGLE_CLIENT_DEFAULTS = {
  clientId: process.env.MONAD_GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.MONAD_GOOGLE_CLIENT_SECRET ?? "",
};

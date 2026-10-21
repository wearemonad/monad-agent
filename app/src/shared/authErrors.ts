/** Does this failure text mean the Claude Code CLI's own login is gone?
 *
 *  Subscription mode rides the user's `claude` binary, and when its OAuth
 *  refresh fails the CLI does NOT throw — it answers the prompt with a
 *  synthetic "Failed to authenticate: …" message and an errored result. Only
 *  a fresh `claude auth login` fixes that, so the UI needs to recognise the
 *  shape and offer one. Shared by the bun side (which flags the run) and the
 *  webview (history replay). Deliberately narrow: a generic "401" from an
 *  MCP connector must not send the user to re-login to Claude. */
export function isClaudeLoginError(text: string | undefined | null): boolean {
  if (!text) return false;
  return (
    /oauth (session|token) (has )?expired/i.test(text) ||
    /could not be refreshed/i.test(text) ||
    /failed to authenticate/i.test(text) ||
    /not logged in/i.test(text) ||
    /please run \/login/i.test(text) ||
    /authentication_error/i.test(text) ||
    /invalid authentication/i.test(text) ||
    /refresh token .*(invalid|revoked|expired)/i.test(text) ||
    /token (has been |was )?revoked/i.test(text)
  );
}

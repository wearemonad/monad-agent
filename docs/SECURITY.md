# Security policy

Monad reads your email, files and business data, so we take reports seriously.

## Reporting a vulnerability

Please **don't** open a public issue. Report privately through GitHub: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the impact you expect.

We aim to acknowledge reports within 3 working days and to agree a disclosure timeline with you. Fixes ship to the latest release; older versions are not patched.

## In scope

- Prompt injection that leads to actions the user didn't approve — for example, a document or email that causes file writes, data exfiltration, or wider tool access, especially in background or scheduled runs.
- Escaping the permission system or a workspace's folder boundary.
- Artifact sandbox escapes (network access or script execution outside the sandboxed view).
- Exposure of credentials or OAuth tokens (Keychain entries, logs, the webview, crash reports).
- Problems in the update channel or the release pipeline.

## Out of scope

- Issues that need an already-compromised Mac or user account.
- The embedded Google *desktop* OAuth client secret — Google doesn't treat it as confidential, and the flow is protected by PKCE.
- Actions the user explicitly approved, or allowed with an "always allow" rule.
- Vulnerabilities in upstream services (Anthropic, OpenAI, Google, MCP servers you connect) — report those to the vendor.

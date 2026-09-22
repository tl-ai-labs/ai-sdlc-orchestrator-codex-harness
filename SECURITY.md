# Security

## Reporting a vulnerability

If you find a security-relevant issue in this repository, please do not open a public issue. Email the maintainers directly at `ai-labs-publish-bot@tilicho.in` with:

- A description of the issue.
- Steps to reproduce.
- The version (commit SHA) you observed it in.
- Any suggested mitigations, if you have them.

We will acknowledge the report within 3 business days and coordinate a fix and disclosure timeline with you.

## Scope

Security-relevant issues include, but are not limited to:

- API keys, tokens, or other secrets accidentally committed to the repo.
- Vulnerabilities in the bundled MCP server (`plugin/mcp/model-dispatch/`).
- Vulnerabilities in the setup or report tooling.
- Any code path that could exfiltrate user data or credentials.

Out of scope:

- General questions about how to use the study — please open a regular issue.
- Missing features that are not security issues.

## Handling of user credentials

Nothing in this repository transmits, uploads, or persists your API keys anywhere except your own local environment. The setup wizard reads keys from your shell environment; it does not write them to disk. Individual pass runs use the keys via the Codex CLI and the local MCP server — the keys never leave your machine except in the form of authenticated API calls to OpenAI and Google. No Anthropic credential is requested or used anywhere in this harness.

If you observe behavior that contradicts the above, treat it as a security issue and report accordingly.

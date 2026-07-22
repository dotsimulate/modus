# Modus support

Modus is an early power-user project, not a generally supported production
service. Community help is best-effort and has no response-time guarantee.

## Security vulnerabilities

Do not open a public issue for a vulnerability or include exploit details in a
public discussion. Follow [SECURITY.md](SECURITY.md) and use GitHub's private
vulnerability-reporting channel.

## Bugs

Use the bug-report issue form. Include the Modus version or commit, operating
system, source-versus-package mode, backend mode, provider, minimal reproduction,
expected behavior, and sanitized diagnostics. Before uploading a screenshot or
log, remove private paths, usernames, host/Tailnet names, credentials, project
and session content, and other identifying data.

## Feature requests and questions

Use the feature-request issue form for a concrete proposal. Ordinary usage
questions may be opened as an issue while no separate community forum is
documented. Search existing issues and documentation first.

## Current support boundary

- Source/browser workflows on Windows, macOS, and Linux are active development
  surfaces, not a compatibility guarantee for every distribution or provider.
- The Windows desktop remains a tester surface. The old unsigned `v0.1.0`
  asset was withdrawn, and no broadly qualified installer is currently available.
- Packaged macOS and Linux applications have not been released.
- Provider CLIs, model services, Tailscale, WebView runtimes, and authored local
  extensions are separate dependencies with their own support and security
  policies.
- User-authored moves, actions, plugins, MCP servers, and `.modus` code execute
  as trusted local code and remain the operator's responsibility.
- A PIN-authenticated browser is an operator-level, full-machine principal, not
  a project-root sandbox. Use a PIN before shared-Tailnet access and do not
  connect remote backends or executable extensions you would not trust with the
  same local authority.

Maintainers may close reports that cannot be reproduced, omit required context,
contain unsafe/private material, concern unsupported third-party behavior, or
request guarantees outside this early-project boundary.

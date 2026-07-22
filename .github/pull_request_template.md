## What changed

Describe the user-visible behavior and why this is the smallest coherent change.

## Verification

List exact commands and results. Explain every relevant skipped check.

## Risk and recovery

Describe compatibility, migration, rollback, process cleanup, and platform-specific consequences.

## Checklist

- [ ] I kept this change focused and reviewed the complete diff.
- [ ] Tests used isolated Modus home/data/config/runtime/log/cache paths and did not touch a live daemon, user database, installed app, or real Tailscale route.
- [ ] I did not add TODO/handoff material, profiles, databases, WAL/SHM files, logs, credentials, environment files, generated runtime state, build output, or personal examples.
- [ ] I sanitized paths, usernames, email addresses, host/Tailnet names, project/session content, screenshots, fixtures, and logs.
- [ ] I ran `.github/scripts/check-publication-boundary.ps1`.
- [ ] I added positive and negative tests for changed security or authorization boundaries.
- [ ] I documented whether moves/actions/plugins/MCP/provider code is trusted local execution and did not imply sandboxing where none exists.
- [ ] I recorded source/package and operating-system limitations.
- [ ] I updated relevant public documentation, or explained why no documentation change is needed.
- [ ] I did not add release assets, publishing behavior, signing credentials, or mutable release inputs.

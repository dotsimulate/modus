# Security policy

## Project status

Modus is pre-release, local-first agent infrastructure for trusted operators. The current desktop build is a Windows tester preview, not a broadly qualified production release. macOS and Linux desktop packages have not been released.

Security fixes currently target the latest source on `main` and the newest prerelease. Older prereleases may be superseded rather than maintained as separate supported lines; published artifacts are never silently replaced in place.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security** tab using **Report a vulnerability** / a private GitHub Security Advisory.

Do not open a public issue for a vulnerability that could expose credentials, private data, remote access, filesystem access, native command execution, provider execution, package integrity, or a practical exploit path. If private reporting is temporarily unavailable, contact the repository maintainer privately through GitHub without including exploit details in a public thread.

Include, when possible:

- affected commit, version, platform, and operating mode;
- the boundary crossed and the authority gained;
- minimal reproduction steps or a proof of concept;
- whether the issue requires operator-installed code or configuration;
- logs with tokens, usernames, hostnames, Tailnet names, and private paths removed;
- suggested mitigations or known workarounds.

Please allow time to reproduce, fix, and coordinate a release before public disclosure. The project will acknowledge a reproducible report, keep the reporter informed when practical, and credit reporters who want attribution.

## Trust model

Modus is a power-user development tool. A trusted operator can intentionally run provider CLIs, MCP servers, terminals, moves, actions, plugins, extensions, and project-local `.modus` code. Operator-authored or explicitly operator-installed local code is inside the trusted execution envelope and may read or modify files and launch processes with the authority of the Modus user.

A PIN-authenticated browser is also an operator-level, full-machine principal. It may use the same broad filesystem and agent authority as the locally installed application; it is not a project-root sandbox. Protect Tailnet/browser access accordingly. Remote backends and their supplied content do not automatically deserve that authority. In particular, remote-backend-supplied executable client extensions are an unresolved privileged-renderer boundary and must be treated as trusted until REMOTE-01 is closed.

A report about trusted local code doing what the operator installed or authored it to do is not, by itself, a security-boundary bypass. Reports are especially useful when they demonstrate that a less-trusted surface acquires that authority unexpectedly, including:

- unauthenticated, cross-origin, or insufficiently authorized clients;
- browser or PIN sessions exceeding their documented scope;
- remote backends or remote content reaching local native functionality;
- model/provider output executing active content unexpectedly;
- path, symlink, archive, URL, command, or environment injection crossing a documented boundary;
- credential disclosure through URLs, logs, process arguments, temporary files, diagnostics, or packages;
- sandbox, capability, approval, target-identity, or provider-policy bypass;
- package, update, installer, dependency, build, signing, or release provenance compromise;
- corruption, loss, or unintended publication of private user data.

Modus is not currently designed as an adversarial multi-tenant boundary for mutually untrusted users sharing one host process.

## Safe testing

- Use isolated `MODUS_HOME`, configuration, data, runtime, log, and cache directories.
- Use dynamic ports and the packaged fake-Tailscale harness.
- Do not alter a reporter's or maintainer's real Tailscale Serve/Funnel configuration.
- Do not test against real user databases without explicit authorization and backups.
- Do not publish credentials, private host/Tailnet names, usernames, personal paths, or private repository history.
- Do not run or distribute a weaponized proof of concept beyond what is necessary to demonstrate the issue safely.

Thank you for helping make powerful local agent infrastructure safer without obscuring its intended trust model.

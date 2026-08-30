---
title: Third-Party Notices
audience: user
covers: harness/scripts/generate-notices.ts harness/notices/overrides.json
---

Where the license notices for everything Modus redistributes live, and how they are produced.

# Third-Party Notices

Modus is licensed under Apache-2.0. The desktop package redistributes a great deal more
than that: a verbatim copy of the Bun runtime, two Rust executables, and JavaScript
bundles that inline the source of their npm dependency trees. Those carry attribution
obligations `LICENSE` does not satisfy on its own.

The complete notices are **`THIRD-PARTY-NOTICES.md`**, at the repository root and installed
beside the packaged server. It is over a megabyte of license text, which is why it is a
file rather than a doc: every doc is scanned line by line on every documentation search,
and license boilerplate would both slow that down and outrank real documentation on words
like "software" and "distribution".

`sbom.cdx.json` beside it is the same inventory in CycloneDX 1.6, for tooling.

## What is covered

What the package **ships**, not everything in the lockfiles:

- npm — the transitive closure of each workspace's `dependencies`. `devDependencies` are
  build tooling and reach no artifact.
- cargo — the crate graph under normal and build dependency kinds. `dev` kinds build tests.
- The Bun runtime, whose aggregated upstream notice is vendored at
  `desktop/third-party/bun/LICENSE.md` and stamped with the version it was taken from.

Platform-specific native packages are only installed and shipped for the target being
built, so the notices are resolved for one target and record which. Today that is
`win32-x64`, the only target with a package.

Microsoft Edge WebView2 is a system component on Windows and is not redistributed.

## Regenerating

```
bun run notices:generate     # from harness/
```

This rewrites `THIRD-PARTY-NOTICES.md`, `sbom.cdx.json`, and
`desktop/installer-license.txt` — the last being what the installer's license page shows,
which is the Apache-2.0 text plus a pointer to the full notices.

Drift is a red test. `notices.test.ts` fails when the committed JavaScript section stops
matching the dependency graph; CI's Rust job runs `bun run notices:check rust`, because
it is the only job with a populated cargo registry to read crate license text from.

A component that publishes no usable license field makes the generator throw by name. Add
it to `harness/notices/overrides.json` with the SPDX expression and the source the license
was read from — never delete the component to make the build pass.

## Licenses that are not open source

`@anthropic-ai/claude-agent-sdk` and its platform sidecars are proprietary: "© Anthropic
PBC. All rights reserved." They are recorded as `LicenseRef-Anthropic-Commercial`.
Redistributing them inside a package is governed by Anthropic's legal agreements rather
than by an open-source grant.

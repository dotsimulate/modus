# Modus release policy

Source publication and downloadable application packages are separate release
surfaces. Passing source checks does not qualify an installer, and publishing a
tag does not authorize uploading or replacing an artifact.

## Current status

- The source project is early and the public-readiness gates are still being
  completed.
- The old unsigned Windows `v0.1.0` asset was withdrawn. Its prerelease page
  and tag remain as historical records with zero downloadable assets.
- No generally qualified Windows installer is currently available. Any future
  candidate requires a new version and the qualification below.
- macOS and Linux desktop packages have not been released.
- The opt-in updater foundation is present, but ordinary builds have no update
  endpoint or signature key configured. Enabling a production channel remains
  blocked on install, upgrade, downgrade, rollback, uninstall, and
  data-preservation qualification. Updates are never downloaded or installed
  without user confirmation; urgency labels only change presentation.

## Version and artifact rules

- Use semantic prerelease versions while compatibility and packaging remain
  experimental.
- Build every release from the exact reviewed tag and committed lockfiles in a
  clean, generic build path.
- Never silently replace an existing release asset. A remediated build receives
  a new version and tag.
- Record the source commit, toolchain versions, dependency locks, artifact size,
  and SHA-256 digest.
- Keep release notes precise about supported operating systems, signing status,
  known limitations, migration behavior, and tests actually performed.
- Do not enable publishing, signing, or release workflows on untrusted pull
  request code.

## Package qualification

A publicly downloadable package requires more than a successful compilation.
Its release evidence should include:

- clean install plus running-process upgrade, downgrade, rollback, uninstall,
  reinstall, and user-data preservation results;
- a fresh-shell check that the installer-owned `modus` command resolves ahead
  of any source-checkout shim, runs without a checkout or global Bun, and leaves
  unrelated user-PATH entries untouched through upgrade and uninstall;
- packaged provider, authored-content, remote-client, crash, and lifecycle
  checks on clean operating-system users or virtual machines;
- inspection for credentials, profiles, databases, logs, source maps, private
  names, usernames, and checkout paths;
- project and third-party license/notice material plus an SBOM;
- reproducible input records and build provenance/attestation;
- platform-appropriate signing, including the installer and inner executable on
  Windows; and
- independent checksum and signature verification after upload.

Release credentials and signing identities must be restricted to an explicitly
authorized protected workflow. The baseline CI workflow intentionally has
read-only repository permissions and no publish capability.

## Retention and rollback

Retain the reviewed tag, source archive, checksums, provenance, notices/SBOM,
and qualified artifact long enough to investigate a report and reproduce the
release. Keep updater and rollback policy conservative until data preservation
and sidecar replacement are proven. User data under `~/.modus` must not be
deleted by a normal upgrade or uninstall without an explicit user choice.

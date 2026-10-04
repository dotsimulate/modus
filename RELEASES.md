# Modus release policy

Source publication and downloadable application packages are separate release
surfaces. Passing source checks does not qualify an installer, and publishing a
tag does not authorize uploading or replacing an artifact.

## Current status

- `v0.3.1` is the first Windows alpha prerelease: an NSIS installer for
  Windows x64 whose installer and Modus executables are Authenticode-signed
  and timestamped. Its GitHub release attaches SHA-256 checksums and a
  build-specific SBOM, and its notes list the checks that were and were not
  performed. It has not completed the package qualification below, so treat
  it as an alpha and back up `~/.modus` before installing over an earlier
  build.
- The old unsigned Windows `v0.1.0` asset was withdrawn. Its prerelease page
  and tag remain as historical records with zero downloadable assets.
- macOS and Linux desktop packages have not been released.
- The opt-in updater foundation is present, but neither ordinary builds nor
  `v0.3.1` have an update endpoint or signature key configured; newer
  versions are installed manually. Enabling a production channel remains
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

A qualified package requires more than a successful compilation. Its release
evidence should include:

- clean install plus running-process upgrade, downgrade, rollback, uninstall,
  reinstall, and user-data preservation results;
- a fresh-shell check that the installer-owned `modus` command resolves ahead
  of any source-checkout shim, runs without a checkout or global Bun, and leaves
  unrelated user-PATH entries untouched through upgrade and uninstall;
- packaged provider, authored-content, remote-client, crash, and lifecycle
  checks on clean operating-system users or virtual machines;
- inspection for credentials, profiles, databases, logs, source maps, private
  names, usernames, and checkout paths;
- project and third-party license/notice material plus an SBOM — `THIRD-PARTY-NOTICES.md`
  and `sbom.cdx.json` are generated and drift-checked in CI, and `bun run release:sbom`
  stamps a build-specific SBOM carrying the source commit, toolchain versions, and a
  SHA-256 per shipped file;
- reproducible input records and build provenance/attestation;
- platform-appropriate signing, including the installer and inner executable on
  Windows; and
- independent checksum and signature verification after upload.

An alpha prerelease may be published before that evidence is complete. It must
still be built from the reviewed tag in a clean build path, signed where the
platform supports it, and published with checksums and an SBOM. Its release
notes state exactly which checks ran and which did not.

Release credentials and signing identities must be restricted to an explicitly
authorized protected workflow. The baseline CI workflow intentionally has
read-only repository permissions and no publish capability.

## Retention and rollback

Retain the reviewed tag, source archive, checksums, provenance, notices/SBOM,
and qualified artifact long enough to investigate a report and reproduce the
release. Keep updater and rollback policy conservative until data preservation
and sidecar replacement are proven. User data under `~/.modus` must not be
deleted by a normal upgrade or uninstall without an explicit user choice.

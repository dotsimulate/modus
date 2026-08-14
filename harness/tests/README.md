# Harness tests

Run the collected suite from `harness/`:

```bash
bun test
```

Bun discovers `*.test.ts` and `*.test.tsx` recursively. Tests are grouped by the
runtime surface they exercise:

- `providers/` — provider adapters, discovery, and process boundaries
- `ui/` — browser-state and source-contract tests
- `sdk/` — public SDK contracts
- `moves/` — built-in move behavior
- `fixtures/` — test-only executables and authored content
- `manual/` — opt-in drivers that are not collected by `bun test`

Keep product source outside this directory. Manual SDK drivers can contact a live
harness and may spend model tokens; read their headers and set their environment
explicitly before running them.

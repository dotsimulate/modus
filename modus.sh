#!/bin/bash
exec bun run "$(dirname "${BASH_SOURCE[0]}")/harness/cli.ts" "$@"

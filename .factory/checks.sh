#!/usr/bin/env bash
# The repo's checks. Exit 0 only when a branch is fit to review.
# Runs in a job's worktree; keep it non-interactive and never rewrite files.
set -euo pipefail

bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build

#!/usr/bin/env bash
# Sample gate script for the fixture board; never run.
set -euo pipefail
bun run lint && bun run test

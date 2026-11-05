#!/bin/sh
# Points git at the versioned hooks in .githooks/ (W0-P1). Safe to re-run.
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "git hooks enabled (core.hooksPath=.githooks)"

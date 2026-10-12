#!/usr/bin/env bash
# Copies the fixture app into a fresh git repo for an end-to-end /monarch run.
# Usage: tests/e2e-setup.sh [target-dir]   (default: /tmp/monarch-e2e)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-/tmp/monarch-e2e}"
rm -rf "$DEST"
cp -R "$HERE/fixture-app" "$DEST"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "chore: initial calc library"
echo "Fixture ready at $DEST"
echo "Next: cd $DEST && claude, then run:"
echo '  /monarch add modulo and power operations with tests; modulo by zero throws RangeError'

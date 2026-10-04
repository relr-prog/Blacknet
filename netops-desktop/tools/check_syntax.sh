#!/bin/bash
# Syntax-checks every JS file the app ships, then runs the whole Node suite.
# Kept as a script because the loop is awkward to quote inline through PowerShell.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

status=0
while IFS= read -r file; do
  if ! node --check "$file" >/dev/null 2>&1; then
    echo "SYNTAX FAIL: $file"
    node --check "$file"
    status=1
  fi
done < <(find src tools test -name '*.js' -not -path '*/node_modules/*')

if [ "$status" -ne 0 ]; then
  echo "--- syntax errors above ---"
  exit 1
fi
echo "--- syntax ok ---"

node --test test/ 2>&1 | tail -9
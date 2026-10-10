#!/bin/bash
set -uo pipefail
cd /home/rel4ever/projects/netops-desktop
UD="$HOME/.config/blacknet-desktop"
mkdir -p "$UD"
printf '{"tabs": [], "activeId": null}' > "$UD/session.json"
rm -f "$UD/zoom.json" "$UD/downloads.json"
rm -rf "/tmp/blacknet-downloads-smoke" 2>/dev/null || true
npm run smoke > /tmp/smoke-full.log 2>&1
grep -c "FAIL" /tmp/smoke-full.log
grep "checks passed" /tmp/smoke-full.log
#!/usr/bin/env bash
# Launch the netops desktop shell detached from the calling shell, so closing the
# terminal (or a tool call ending) does not take the window down with it.
set -u
cd "$(dirname "$0")"

pkill -9 -f dist/electron 2>/dev/null
pkill -9 -f "uvicorn netops" 2>/dev/null
sleep 2

LOG="${NETOPS_LOG:-/tmp/netops-live.log}"
setsid nohup ./node_modules/.bin/electron . --no-sandbox --disable-gpu \
  > "$LOG" 2>&1 < /dev/null &
disown

echo "launched, log: $LOG"
#!/bin/sh
# Stands in for `claude agents --json` in the hub's tests.
[ "$1 $2" = "agents --json" ] || exit 2
cat "${FAKE_AGENTS:-/dev/null}" 2>/dev/null || echo '[]'

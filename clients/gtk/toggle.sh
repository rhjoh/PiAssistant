#!/usr/bin/env bash
# Launch the agent GUI if it is not already running.
#
# labwc owns live minimize/restore/workspace toggling so the same Wayland
# surface (and therefore its compositor-managed geometry) is retained. This
# script is the <none> fallback in that compositor rule and is also safe to
# invoke directly.
# The PID file is written by agent-gui.py on startup and removed on exit.
set -uo pipefail

PIDFILE="${XDG_RUNTIME_DIR:-/tmp}/agent-gui.pid"

if [[ -f "$PIDFILE" ]]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
  rm -f "$PIDFILE"
fi

exec python3 "$(cd "$(dirname "$0")" && pwd)/agent-gui.py"

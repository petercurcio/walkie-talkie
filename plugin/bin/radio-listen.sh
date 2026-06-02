#!/bin/sh
# radio-listen.sh - persistent walkie-talkie accumulator.
#
# Long-polls the hub via radio-wait.sh and APPENDS every received message to an
# inbox file, so a Claude Code agent can drain the queue on its own schedule
# (e.g. at the top of each turn) instead of being woken per message. This is the
# "background listening without per-message interruption" pattern.
#
# Usage: radio-listen.sh <hub_url> <token> <inbox_file> [pidfile]
#
# Singleton (scoped, NOT machine-wide): if <pidfile> is given and names a live
# process, that process is killed before this one starts. Pass a pidfile unique
# to the agent (e.g. /tmp/radio-<name>.pid). Never `pkill -f radio-wait.sh` to
# enforce singletons - that is machine-wide and kills every other agent's
# listener on a shared hub.
#
# Exit discipline: radio-wait.sh returns 0 on a received message (we append and
# keep looping) and non-zero on kill / connection error / 401 stale-token. On
# non-zero we STOP rather than relaunch - relaunching a dead token is exactly
# what caused the rejoin/401 churn. We leave a RADIO_DOWN marker in the inbox so
# the agent knows to re-fetch its token (radio_token) and restart.

set -u

HUB="${1:-}"
TOKEN="${2:-}"
INBOX="${3:-}"
PIDFILE="${4:-}"

if [ -z "$HUB" ] || [ -z "$TOKEN" ] || [ -z "$INBOX" ]; then
  echo "Usage: radio-listen.sh <hub_url> <token> <inbox_file> [pidfile]" >&2
  exit 1
fi

WAIT="$(cd "$(dirname "$0")" && pwd)/radio-wait.sh"
if [ ! -x "$WAIT" ]; then
  echo "radio-listen.sh: radio-wait.sh not found/executable at $WAIT" >&2
  exit 1
fi

# Per-agent singleton guard (scoped via pidfile, never pkill-by-name).
if [ -n "$PIDFILE" ]; then
  if [ -f "$PIDFILE" ]; then
    old=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; then
      kill "$old" 2>/dev/null || true
      sleep 1
    fi
  fi
  echo $$ > "$PIDFILE"
  trap 'rm -f "$PIDFILE"' EXIT INT TERM
fi

while true; do
  out=$("$WAIT" "$HUB" "$TOKEN")
  rc=$?
  if [ "$out" = "RADIO_KILLED" ]; then
    printf 'RADIO_DOWN: token rejected (401) or killed - re-fetch token and restart\n' >> "$INBOX"
    break
  fi
  if [ -n "$out" ]; then
    printf '%s\n' "$out" >> "$INBOX"
  fi
  if [ "$rc" -ne 0 ]; then
    printf 'RADIO_DOWN: listener exited (rc=%s) - re-fetch token and restart\n' "$rc" >> "$INBOX"
    break
  fi
done

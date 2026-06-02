#!/bin/sh
# radio-listen.sh - walkie-talkie listener with relevance-filtered wake.
#
# Long-polls the hub via radio-wait.sh and APPENDS every received message to an
# inbox file. It keeps polling silently through fleet cross-talk, but EXITS 0
# (which completes the background task and immediately wakes the agent - even
# from full idle) the moment a message addressed to THIS agent (-> <handle>: or
# -> @all:) arrives. So:
#   - a message for you  -> immediate wake (idle or after your current turn)
#   - fleet cross-talk    -> logged to the inbox, no wake
# The agent re-launches radio-listen.sh after each wake to keep listening.
# Omit <handle> to never wake (pure silent accumulator).
#
# Usage: radio-listen.sh <hub_url> <token> <inbox_file> [pidfile] [handle]
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
HANDLE="${5:-}"

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
      pkill -P "$old" 2>/dev/null || true   # its radio-wait child
      kill "$old" 2>/dev/null || true
      sleep 1
      # force-kill if the old listener (or its child) survived the TERM
      kill -0 "$old" 2>/dev/null && kill -9 "$old" 2>/dev/null
      pkill -9 -P "$old" 2>/dev/null || true
    fi
  fi
  echo $$ > "$PIDFILE"
  # EXIT cleans up the pidfile; INT/TERM must also EXIT (a cleanup-only trap that
  # falls through would leave the process running and defeat the singleton guard).
  trap 'rm -f "$PIDFILE"' EXIT
  trap 'rm -f "$PIDFILE"; exit 143' TERM
  trap 'rm -f "$PIDFILE"; exit 130' INT
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
    # Immediate wake when a captured line is addressed to this agent (or @all).
    # Exiting 0 completes the background task, which wakes the agent right away -
    # even from full idle. Fleet cross-talk falls through and keeps polling.
    if [ -n "$HANDLE" ] && printf '%s\n' "$out" | grep -qE -- "-> (${HANDLE}|@all):"; then
      exit 0
    fi
  fi
  if [ "$rc" -ne 0 ]; then
    # 143 (TERM) / 130 (INT) = the radio-wait child was killed by signal - e.g.
    # the singleton guard replacing this listener, or radio_out. That's
    # intentional, not a failure, so exit quietly WITHOUT a RADIO_DOWN marker
    # (those should only signal genuine token-death or connection failure).
    if [ "$rc" -eq 143 ] || [ "$rc" -eq 130 ]; then
      exit 0
    fi
    printf 'RADIO_DOWN: listener exited (rc=%s) - re-fetch token and restart\n' "$rc" >> "$INBOX"
    break
  fi
done

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
# Exit discipline: radio-wait.sh prints RADIO_KILLED + exits non-zero on a 401 /
# explicit kill (token genuinely gone), and exits non-zero with EMPTY stdout on a
# connection outage (hub unreachable - laptop asleep/offline, network change).
# We treat those two differently:
#   - 401 / RADIO_KILLED  -> token is dead; stop and leave a RADIO_DOWN marker so
#                            the agent re-fetches its token (radio_token) + restarts.
#   - connection outage    -> the token is STILL VALID (as long as the hub's
#                            stale-grace outlives the outage); do NOT give up. Back
#                            off and keep retrying the SAME token so a single
#                            listener rides out a multi-hour laptop sleep instead of
#                            dying and needing a manual restart. Re-registering here
#                            would be wrong: it desyncs the shell's token from the
#                            MCP server's, breaking sends/re-join. Token survival is
#                            the hub-side fix (configurable STALE_GRACE_MS); this
#                            side just has to not quit on a transient outage.
#
# Backoff is env-tunable (RADIO_BACKOFF_MIN / RADIO_BACKOFF_MAX, seconds) so tests
# can run it fast and operators can adjust it.
# The wait binary is RADIO_WAIT_BIN if set (test seam), else sibling radio-wait.sh.

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

WAIT="${RADIO_WAIT_BIN:-$(cd "$(dirname "$0")" && pwd)/radio-wait.sh}"
if [ ! -x "$WAIT" ]; then
  echo "radio-listen.sh: radio-wait.sh not found/executable at $WAIT" >&2
  exit 1
fi

# At-least-once delivery state, co-located with the inbox (same durability). radio-wait reads
# these to send its cursor on each poll and dedup redelivered ids; it advances the cursor only
# after surfacing a message, so anything unconfirmed re-delivers. An env override wins (test
# seam / operator who wants a durable-dir cursor that survives a /tmp wipe). Exported so the
# radio-wait child inherits them.
: "${RADIO_CURSOR_FILE:=${INBOX}.cursor}"
: "${RADIO_SEEN_FILE:=${INBOX}.seen}"
export RADIO_CURSOR_FILE RADIO_SEEN_FILE

# Reconnect backoff after a connection outage (env-tunable; resets on a healthy poll).
BACKOFF_MIN="${RADIO_BACKOFF_MIN:-5}"
BACKOFF_MAX="${RADIO_BACKOFF_MAX:-120}"
backoff="$BACKOFF_MIN"

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

# Persist the token next to the pidfile so a re-arm after a wake can relaunch WITHOUT a fresh
# radio_join/radio_token round-trip: a wake-exit does NOT unregister the agent and (with grace
# disabled) the token stays valid, so re-joining every wake is pure churn. The token file's
# PRESENCE means "token still believed valid" — it is deliberately NOT removed on a normal exit
# (only on RADIO_DOWN below, when the token is actually dead). The auto-arm hook keys off it:
# present -> cheap relaunch with this token; absent -> full radio_join.
TOKEN_FILE=""
if [ -n "$PIDFILE" ]; then
  TOKEN_FILE="${PIDFILE%.pid}.token"
  printf '%s' "$TOKEN" > "$TOKEN_FILE" 2>/dev/null || TOKEN_FILE=""
fi

while true; do
  out=$("$WAIT" "$HUB" "$TOKEN")
  rc=$?

  # Genuine token death (401 / explicit kill): radio-wait prints RADIO_KILLED.
  # The token is gone - stop and signal so the agent re-fetches it and restarts.
  if [ "$out" = "RADIO_KILLED" ]; then
    printf 'RADIO_DOWN: token rejected (401) or killed - re-fetch token and restart\n' >> "$INBOX"
    # Token is genuinely dead — drop the cached token so the auto-arm hook does a FULL
    # radio_join (cheap relaunch would just 401 again).
    [ -n "$TOKEN_FILE" ] && rm -f "$TOKEN_FILE"
    break
  fi

  if [ -n "$out" ]; then
    printf '%s\n' "$out" >> "$INBOX"
    backoff="$BACKOFF_MIN"   # healthy poll - reset the outage backoff
    # HYBRID wake policy (rate-limit mitigation): each wake = one LLM turn, and a plain @all
    # used to wake EVERY agent (N turns per broadcast) — the dominant Anthropic API load. Now
    # wake only on something that actually needs THIS agent now:
    #   - a direct message to this handle ("-> <handle>:"), OR
    #   - an @all that explicitly @-mentions this handle ("-> @all: ... @<handle>").
    # A plain @all (no mention) and @all-to-someone-else are captured to the inbox but do NOT
    # wake — they surface at the next turn-end via the Stop-drain hook. Nothing is lost; the
    # broadcast just stops yanking the whole fleet into a turn. Exiting 0 completes the
    # background task, which wakes the agent immediately, even from full idle.
    if [ -n "$HANDLE" ] && {
      printf '%s\n' "$out" | grep -qE -- "-> ${HANDLE}:" ||
        printf '%s\n' "$out" | grep -qE -- "-> @all:.*@${HANDLE}([^[:alnum:]_-]|$)"
    }; then
      exit 0
    fi
    continue
  fi

  # 143 (TERM) / 130 (INT) = the radio-wait child was killed by signal - e.g. the
  # singleton guard replacing this listener, or radio_out. Intentional, not a
  # failure, so exit quietly WITHOUT a RADIO_DOWN marker. (sleep below is
  # interruptible by these signals, so the singleton guard still works promptly.)
  if [ "$rc" -eq 143 ] || [ "$rc" -eq 130 ]; then
    exit 0
  fi

  if [ "$rc" -ne 0 ]; then
    # Connection outage (empty stdout + non-zero rc): hub unreachable. Do NOT
    # quit - the token survives the outage (hub stale-grace permitting), and a
    # 401 would have surfaced as RADIO_KILLED above. Back off and keep retrying
    # the SAME token so one listener rides out a laptop sleep, then resumes.
    sleep "$backoff"
    backoff=$((backoff * 2))
    [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff="$BACKOFF_MAX"
    continue
  fi
  # rc==0 with empty out: nothing delivered, no error - just re-poll.
done

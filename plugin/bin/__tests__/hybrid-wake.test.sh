#!/bin/sh
# Test: radio-listen.sh HYBRID wake policy (2026-06-07, rate-limit mitigation).
#
# Each immediate wake = one LLM turn for the agent, and a plain @all woke EVERY agent (N turns
# per broadcast) — the dominant driver of Anthropic API load across the fleet. Hybrid policy:
#   - direct message to this handle (-> <handle>:)            -> WAKE
#   - @all that @-mentions this handle (-> @all: ... @<h>)    -> WAKE
#   - plain @all (no mention)                                 -> capture to inbox, NO wake
#   - @all mentioning a DIFFERENT handle                      -> capture, NO wake
# Nothing is lost: un-woken messages still land in the inbox (surfaced at the next turn-end by
# the Stop-drain hook). This just stops broadcasts from yanking the whole fleet into a turn.
#
# Detection (same trick as reconnect.test.sh): a message that WAKES ends the listener, so any
# message queued AFTER it is never polled and won't appear in the inbox. A message that does
# NOT wake lets the listener keep going, so the following message DOES appear.

set -u

DIR=$(dirname "$0")
LISTEN="$(cd "$DIR/.." && pwd)/radio-listen.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

MOCK="$TMP/mock-wait.sh"
cat > "$MOCK" <<'MOCK_EOF'
#!/bin/sh
line=$(head -n1 "$MOCK_QUEUE" 2>/dev/null)
tail -n +2 "$MOCK_QUEUE" > "$MOCK_QUEUE.tmp" 2>/dev/null && mv "$MOCK_QUEUE.tmp" "$MOCK_QUEUE"
case "$line" in
  MSG:*) echo "${line#MSG:}"; exit 0 ;;
  *)     exit 1 ;;   # queue exhausted -> outage (listener backs off; case must wake before this)
esac
MOCK_EOF
chmod +x "$MOCK"

fail=0
run_case() { # $1 desc, $2 newline-joined queue
  inbox="$TMP/inbox"; : > "$inbox"
  printf '%s\n' "$2" > "$TMP/queue"
  MOCK_QUEUE="$TMP/queue" RADIO_WAIT_BIN="$MOCK" RADIO_BACKOFF_MIN=0 RADIO_BACKOFF_MAX=0 \
    sh "$LISTEN" http://hub TESTTOKEN "$inbox" "" skills >/dev/null 2>&1
}
assert_yes() { if grep -q -- "$2" "$1"; then echo "PASS: $3"; else echo "FAIL: $3 (missing '$2')"; fail=1; fi; }
assert_no()  { if grep -q -- "$2" "$1"; then echo "FAIL: $3 (unexpected '$2')"; fail=1; else echo "PASS: $3"; fi; }

# --- Case 1: plain @all does NOT wake (the rate-limit fix) -------------------
# Listener must keep going past a plain @all, so the following direct message is reached.
run_case "plain-all-no-wake" "MSG:[12:00:00] #all alice -> @all: general status update
MSG:[12:00:01] #all alice -> skills: direct followup"
assert_yes "$TMP/inbox" "@all: general status" "plain @all captured to inbox"
assert_yes "$TMP/inbox" "skills: direct followup" "listener kept going past plain @all (no wake)"

# --- Case 2: @all that @-mentions this handle DOES wake ----------------------
# It wakes on the mention, so the message queued after it is never reached.
run_case "all-mention-wakes" "MSG:[12:00:02] #all alice -> @all: heads up @skills please look
MSG:[12:00:03] #all alice -> dora: should-not-be-reached"
assert_yes "$TMP/inbox" "@skills please look" "@all mentioning @skills captured"
assert_no  "$TMP/inbox" "should-not-be-reached" "@all @skills mention woke the listener (stopped)"

# --- Case 3: @all mentioning a DIFFERENT handle does NOT wake ----------------
run_case "all-other-mention-no-wake" "MSG:[12:00:04] #all alice -> @all: hey @dora ping
MSG:[12:00:05] #all alice -> skills: direct after"
assert_yes "$TMP/inbox" "@dora ping" "@all mentioning @dora captured"
assert_yes "$TMP/inbox" "skills: direct after" "listener kept going past @all-@dora (no wake)"

# --- Case 4: a direct message still wakes (unchanged) -----------------------
run_case "direct-wakes" "MSG:[12:00:06] #all alice -> skills: direct ping
MSG:[12:00:07] #all alice -> dora: unreached"
assert_yes "$TMP/inbox" "skills: direct ping" "direct message captured"
assert_no  "$TMP/inbox" "unreached" "direct message woke the listener (stopped)"

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"

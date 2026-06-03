#!/bin/sh
# Test: radio-listen.sh reconnect behavior.
#
# Verifies the connection-outage resilience added for laptop-sleep churn:
#   1. A connection outage (hub unreachable) must NOT write RADIO_DOWN or quit -
#      the listener backs off and keeps retrying the same token, then resumes and
#      wakes on a relevant message once the hub returns.
#   2. A genuine 401 (RADIO_KILLED) MUST write RADIO_DOWN and stop (token is dead).
#   3. Fleet cross-talk (a message not addressed to this handle) is captured to the
#      inbox but does NOT wake (no early exit) - the listener keeps polling.
#
# Uses a mock radio-wait via RADIO_WAIT_BIN that pops scripted responses from a
# queue file (one per call): ERR (outage), KILL (401), MSG:<text> (delivery).
# Backoff is forced to 0 (RADIO_BACKOFF_MIN/MAX) so the test is instant.

set -u

DIR=$(dirname "$0")
LISTEN="$(cd "$DIR/.." && pwd)/radio-listen.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

MOCK="$TMP/mock-wait.sh"
cat > "$MOCK" <<'MOCK_EOF'
#!/bin/sh
# Pop the first line of $MOCK_QUEUE and act on it.
line=$(head -n1 "$MOCK_QUEUE" 2>/dev/null)
tail -n +2 "$MOCK_QUEUE" > "$MOCK_QUEUE.tmp" 2>/dev/null && mv "$MOCK_QUEUE.tmp" "$MOCK_QUEUE"
case "$line" in
  ERR)   exit 1 ;;                          # connection outage: empty stdout, rc=1
  KILL)  echo "RADIO_KILLED"; exit 1 ;;     # 401 / explicit kill
  MSG:*) echo "${line#MSG:}"; exit 0 ;;     # delivered message
  *)     exit 1 ;;                          # queue exhausted -> behave as outage
esac
MOCK_EOF
chmod +x "$MOCK"

fail=0
run_case() {
  # $1 = description, remaining = queue lines (passed as newline string in $2)
  desc="$1"; queue="$2"
  inbox="$TMP/inbox"
  : > "$inbox"
  printf '%s\n' "$queue" > "$TMP/queue"
  MOCK_QUEUE="$TMP/queue" RADIO_WAIT_BIN="$MOCK" RADIO_BACKOFF_MIN=0 RADIO_BACKOFF_MAX=0 \
    sh "$LISTEN" http://hub TESTTOKEN "$inbox" "" skills >/dev/null 2>&1
  # caller inspects "$inbox" after
}

assert_no() { # file pattern desc
  if grep -q -- "$2" "$1"; then echo "FAIL: $3 (unexpected '$2')"; fail=1; else echo "PASS: $3"; fi
}
assert_yes() { # file pattern desc
  if grep -q -- "$2" "$1"; then echo "PASS: $3"; else echo "FAIL: $3 (missing '$2')"; fail=1; fi
}

# --- Case 1: two outages then a relevant message ---------------------------
# Listener must ride out the outages (no RADIO_DOWN) and capture the message.
run_case "outage-then-wake" "ERR
ERR
MSG:[12:00:00] #all alice -> skills: hello"
assert_no  "$TMP/inbox" "RADIO_DOWN" "outage does not write RADIO_DOWN"
assert_yes "$TMP/inbox" "skills: hello" "message captured after riding out the outage"

# --- Case 2: genuine 401 -> RADIO_DOWN -------------------------------------
run_case "kill-writes-radio-down" "KILL"
assert_yes "$TMP/inbox" "RADIO_DOWN" "401/RADIO_KILLED writes RADIO_DOWN and stops"

# --- Case 3: cross-talk captured but not woken on, then relevant wakes ------
# A message NOT addressed to 'skills' must be logged but not end the listener;
# the next (relevant) message is what exits it.
run_case "cross-talk-no-wake" "MSG:[12:00:01] #all bob -> dora: standup?
MSG:[12:00:02] #all bob -> skills: ping"
assert_yes "$TMP/inbox" "dora: standup" "cross-talk captured to inbox"
assert_yes "$TMP/inbox" "skills: ping" "relevant message captured (and woke)"
assert_no  "$TMP/inbox" "RADIO_DOWN" "cross-talk path writes no RADIO_DOWN"

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"

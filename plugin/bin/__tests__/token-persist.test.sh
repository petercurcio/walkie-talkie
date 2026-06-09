#!/bin/sh
# Test: radio-listen.sh persists its token for cheap re-arms (2026-06-09, churn fix).
#   - On startup it writes the token to <pidfile-base>.token, so a re-arm after a wake can
#     relaunch WITHOUT a radio_join/radio_token round-trip (the registration + token survive a
#     wake-exit; re-joining every wake was the visible "Registered as…" churn).
#   - The file PERSISTS across a normal wake-exit (token still valid).
#   - It is REMOVED on RADIO_DOWN (token genuinely dead), so the auto-arm hook falls back to a
#     full radio_join instead of cheap-relaunching into another 401.

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
  KILL)  echo "RADIO_KILLED"; exit 1 ;;
  MSG:*) echo "${line#MSG:}"; exit 0 ;;
  *)     exit 1 ;;
esac
MOCK_EOF
chmod +x "$MOCK"

fail=0
run() { # $1 queue
  inbox="$TMP/inbox"; pidfile="$TMP/p.pid"; : > "$inbox"
  printf '%s\n' "$1" > "$TMP/queue"
  MOCK_QUEUE="$TMP/queue" RADIO_WAIT_BIN="$MOCK" RADIO_BACKOFF_MIN=0 RADIO_BACKOFF_MAX=0 \
    sh "$LISTEN" http://hub THETOKEN "$inbox" "$pidfile" skills >/dev/null 2>&1
}

# --- normal wake-exit: token file written AND kept (token still valid) -------------------
run "MSG:[12:00:00] #all alice -> skills: ping"
if [ -f "$TMP/p.token" ] && [ "$(cat "$TMP/p.token")" = "THETOKEN" ]; then
  echo "PASS: token persisted to <pidfile-base>.token on startup"
else
  echo "FAIL: token file missing/incorrect after normal run (got: $(cat "$TMP/p.token" 2>/dev/null))"; fail=1
fi
[ -f "$TMP/p.token" ] && echo "PASS: token file survives a normal wake-exit (cheap re-arm available)" || { echo "FAIL: token file gone after wake-exit"; fail=1; }

# --- RADIO_DOWN: token file removed (force a full re-join next time) ---------------------
run "KILL"
if [ -f "$TMP/p.token" ]; then
  echo "FAIL: token file still present after RADIO_DOWN (would cheap-relaunch into another 401)"; fail=1
else
  echo "PASS: token file removed on RADIO_DOWN (auto-arm will full re-join)"
fi
grep -q "RADIO_DOWN" "$TMP/inbox" && echo "PASS: RADIO_DOWN still written" || { echo "FAIL: RADIO_DOWN missing"; fail=1; }

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"

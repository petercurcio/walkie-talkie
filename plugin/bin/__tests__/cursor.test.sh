#!/bin/sh
# Test: radio-wait.sh at-least-once client support (#7 phase 3).
#
# When RADIO_CURSOR_FILE is set, radio-wait must:
#   1. send its persisted cursor on each poll (?cursor=N), bootstrapping with cursor=init
#      when it has none, and advance the cursor file from the server's returned cursor;
#   2. dedup by message id against RADIO_SEEN_FILE so a redelivered (already-appended)
#      message is not surfaced twice (at-least-once => a message can arrive again).
# When RADIO_CURSOR_FILE is UNSET, radio-wait must behave exactly as before (legacy
# at-most-once: GET /poll with no cursor query), so existing callers are unaffected.
#
# Uses a stub hub that serves a scripted list of JSON responses (one per request) and logs
# each request path, so we can assert both what radio-wait SENT and how it advanced.

set -u

DIR=$(dirname "$0")
WAIT="$(cd "$DIR/.." && pwd)/radio-wait.sh"
TMP=$(mktemp -d)
STUB=""
trap 'rm -rf "$TMP"; [ -n "$STUB" ] && kill "$STUB" 2>/dev/null' EXIT

# Shared stub: serves RESPONSES_FILE (a JSON array) one entry per request, clamping to the
# last entry, and appends each request path to REQLOG. Binds port 0; writes it to PORTFILE.
cat > "$TMP/stub.py" <<'PY'
import http.server, json, os
RESP = json.load(open(os.environ['RESPONSES_FILE']))
REQLOG = os.environ['REQLOG']
PORTFILE = os.environ['PORTFILE']
i = [0]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(REQLOG, 'a') as f:
            f.write(self.path + '\n')
        idx = min(i[0], len(RESP) - 1)
        i[0] += 1
        body = json.dumps(RESP[idx]).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
with open(PORTFILE, 'w') as f:
    f.write(str(srv.server_address[1]))
while True:
    srv.handle_request()
PY

fail=0

# Launch a fresh stub for the responses written to $1; sets PORT.
start_stub() {
  rm -f "$TMP/reqlog" "$TMP/port"
  [ -n "$STUB" ] && kill "$STUB" 2>/dev/null
  RESPONSES_FILE="$1" REQLOG="$TMP/reqlog" PORTFILE="$TMP/port" python3 "$TMP/stub.py" &
  STUB=$!
  i=0
  while [ ! -s "$TMP/port" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  PORT=$(cat "$TMP/port" 2>/dev/null)
  [ -z "$PORT" ] && { echo "FAIL: stub did not start"; exit 1; }
}

check() { # desc, expected, actual
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected '$2', got '$3')"; fail=1; fi
}
contains() { # desc, haystack, needle
  if printf '%s' "$2" | grep -q -- "$3"; then echo "PASS: $1"; else echo "FAIL: $1 (got '$2')"; fail=1; fi
}
notcontains() { # desc, haystack, needle
  if printf '%s' "$2" | grep -q -- "$3"; then echo "FAIL: $1 (got '$2')"; fail=1; else echo "PASS: $1"; fi
}

# --- Scenario 1: dedup + cursor send/advance ---------------------------------------------
cat > "$TMP/resp1.json" <<'JSON'
[
  {"messages":[{"id":"dup1","from":"a","to":"@me","content":"OLD","channel":"#all","timestamp":0}],"cursor":6},
  {"messages":[{"id":"new1","from":"a","to":"@me","content":"NEW","channel":"#all","timestamp":0}],"cursor":7}
]
JSON
start_stub "$TMP/resp1.json"
printf '5' > "$TMP/cur1"          # pre-existing cursor
printf 'dup1\n' > "$TMP/seen1"    # dup1 already seen/appended
out=$(RADIO_CURSOR_FILE="$TMP/cur1" RADIO_SEEN_FILE="$TMP/seen1" "$WAIT" "http://127.0.0.1:$PORT" tok)
contains "fresh message surfaced" "$out" "NEW"
notcontains "already-seen message deduped (not surfaced again)" "$out" "OLD"
check "cursor advanced through the dupe to the fresh message" "7" "$(cat "$TMP/cur1")"
check "first poll used the persisted cursor" "/poll?cursor=5" "$(sed -n 1p "$TMP/reqlog")"
check "second poll used the advanced cursor" "/poll?cursor=6" "$(sed -n 2p "$TMP/reqlog")"
contains "seen file records the new id" "$(cat "$TMP/seen1")" "new1"

# --- Scenario 2: init bootstrap when no cursor exists ------------------------------------
cat > "$TMP/resp2.json" <<'JSON'
[
  {"messages":[],"cursor":9},
  {"messages":[{"id":"x","from":"a","to":"@me","content":"HI","channel":"#all","timestamp":0}],"cursor":10}
]
JSON
start_stub "$TMP/resp2.json"
out=$(RADIO_CURSOR_FILE="$TMP/cur2" RADIO_SEEN_FILE="$TMP/seen2" "$WAIT" "http://127.0.0.1:$PORT" tok)
check "bootstraps with cursor=init when no cursor file exists" "/poll?cursor=init" "$(sed -n 1p "$TMP/reqlog")"
check "adopts the high-water mark then advances" "10" "$(cat "$TMP/cur2")"
contains "message after the established mark is surfaced" "$out" "HI"

# --- Scenario 3: legacy (no RADIO_CURSOR_FILE) is unchanged ------------------------------
cat > "$TMP/resp3.json" <<'JSON'
[
  {"messages":[{"id":"y","from":"a","to":"@me","content":"LEG","channel":"#all","timestamp":0}]}
]
JSON
start_stub "$TMP/resp3.json"
out=$(unset RADIO_CURSOR_FILE RADIO_SEEN_FILE; "$WAIT" "http://127.0.0.1:$PORT" tok)
check "legacy poll sends no cursor query" "/poll" "$(sed -n 1p "$TMP/reqlog")"
contains "legacy poll still surfaces the message" "$out" "LEG"

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"

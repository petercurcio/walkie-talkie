#!/bin/sh
# Test: radio-wait.sh turns a 200 body that doesn't parse into a LOUD, DISTINCT marker
# (RADIO_PARSE_ERROR + exit 4), instead of an empty-stdout exit-1 that's indistinguishable
# from a connection outage. That indistinguishability was the "consume-and-drop" /
# silent-inbox-stall the fleet hit: the hub drains the message on the 200, then radio-wait
# fails to parse and exits like an outage, so radio-listen silently retries and the message
# is lost without a trace.

set -u

DIR=$(dirname "$0")
WAIT="$(cd "$DIR/.." && pwd)/radio-wait.sh"
TMP=$(mktemp -d)
PORTFILE="$TMP/port"
STUB=""
trap 'rm -rf "$TMP"; [ -n "$STUB" ] && kill "$STUB" 2>/dev/null' EXIT

# Stub hub: one GET to /poll returns HTTP 200 with a body that is NOT valid JSON
# (simulates a truncated/corrupt long-poll response). Binds port 0 and writes the real
# port from inside the server (avoids the bind/close race of picking a port separately).
python3 -c "
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'this is not valid json {truncated')
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
with open('$PORTFILE', 'w') as f:
    f.write(str(srv.server_address[1]))
srv.handle_request()
" &
STUB=$!

# wait for the stub to write its port
i=0
while [ ! -s "$PORTFILE" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
PORT=$(cat "$PORTFILE" 2>/dev/null)

fail=0
if [ -z "$PORT" ]; then
  echo "FAIL: stub hub did not start"
  exit 1
fi

out=$("$WAIT" "http://127.0.0.1:$PORT" testtoken)
rc=$?

if printf '%s' "$out" | grep -q "RADIO_PARSE_ERROR"; then
  echo "PASS: parse failure emits a loud RADIO_PARSE_ERROR marker on stdout"
else
  echo "FAIL: expected RADIO_PARSE_ERROR on stdout, got: '$out'"; fail=1
fi

if [ "$rc" -eq 4 ]; then
  echo "PASS: parse failure exits 4 (distinct from outage's 1)"
else
  echo "FAIL: expected exit 4, got $rc"; fail=1
fi

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"

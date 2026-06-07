#!/bin/sh
# Test: radio-wait.sh correctly parses a 200 body whose message content contains newlines
# (valid JSON with escaped \n). Regression for a fleet-wide incident (2026-06-07): the hub
# emits valid JSON, but `echo "$body" | python3` mangled it — /bin/sh's echo interprets the
# escaped \n into real newlines, corrupting the JSON → RADIO_PARSE_ERROR. Because a parse
# fail does NOT advance the delivery cursor, the offending multi-line message redelivered
# forever, tight-looping every cursor-mode listener and taking the whole fleet deaf. The fix
# is to emit body bytes with printf '%s' (no backslash interpretation) instead of echo.

set -u

DIR=$(dirname "$0")
WAIT="$(cd "$DIR/.." && pwd)/radio-wait.sh"
TMP=$(mktemp -d)
PORTFILE="$TMP/port"
STUB=""
trap 'rm -rf "$TMP"; [ -n "$STUB" ] && kill "$STUB" 2>/dev/null' EXIT

# Stub hub: returns ONE 200 with a message whose content has real newlines. json.dumps emits
# valid JSON (the newlines escaped as \n) — exactly what the real hub sends for a multi-
# paragraph message.
python3 -c "
import http.server, json
BODY = json.dumps({'messages':[{
    'id':'ml1','from':'mcp-servers','to':'@all',
    'content':'Two distinct issues:\n\n1) first\n2) second','channel':'#all','timestamp':0
}]})
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(BODY.encode())
    def log_message(self,*a): pass
srv = http.server.HTTPServer(('127.0.0.1',0), H)
open('$PORTFILE','w').write(str(srv.server_address[1]))
srv.handle_request()
" &
STUB=$!

i=0; while [ ! -s "$PORTFILE" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
PORT=$(cat "$PORTFILE" 2>/dev/null)
[ -z "$PORT" ] && { echo "FAIL: stub did not start"; exit 1; }

out=$("$WAIT" "http://127.0.0.1:$PORT" tok)
rc=$?

fail=0
if printf '%s' "$out" | grep -q "RADIO_PARSE_ERROR"; then
  echo "FAIL: multi-line message content triggered RADIO_PARSE_ERROR (the echo-mangling bug)"; fail=1
else
  echo "PASS: multi-line content did not cause a parse error"
fi
if printf '%s' "$out" | grep -q "first" && printf '%s' "$out" | grep -q "second"; then
  echo "PASS: multi-line content surfaced intact"
else
  echo "FAIL: expected both content lines, got: '$out'"; fail=1
fi
if [ "$rc" -eq 0 ]; then echo "PASS: exit 0 (message delivered)"; else echo "FAIL: expected exit 0, got $rc"; fail=1; fi

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"

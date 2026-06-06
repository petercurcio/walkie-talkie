#!/bin/sh
# radio-wait.sh - Long-poll the walkie-talkie hub for incoming messages.
# Usage: radio-wait.sh <hub_url> <token>
# Exits 0 on message received, 1 on kill/error.
# Images are saved as temp files and their paths printed as [image: /path/to/file.png]

set -e

HUB_URL="$1"
TOKEN="$2"

if [ -z "$HUB_URL" ] || [ -z "$TOKEN" ]; then
  echo "Usage: radio-wait.sh <hub_url> <token>" >&2
  exit 1
fi

MAX_RETRIES=3
retry_count=0

# At-least-once delivery (opt-in via RADIO_CURSOR_FILE; unset = legacy at-most-once, byte-for-
# byte unchanged). When set, each poll sends the persisted cursor (?cursor=N), bootstrapping
# with cursor=init when none exists; the python below dedups by id and advances the cursor
# file from the server's returned cursor. State files are read/written fresh each loop, so the
# cursor survives across the radio-listen re-invocations that drive this script.
CURSOR_FILE="${RADIO_CURSOR_FILE:-}"

while true; do
  poll_path="/poll"
  if [ -n "$CURSOR_FILE" ]; then
    cursor=$(cat "$CURSOR_FILE" 2>/dev/null || true)
    [ -z "$cursor" ] && cursor="init"
    poll_path="/poll?cursor=$cursor"
  fi

  # Long-poll with 1 hour timeout (3660s)
  response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" \
    --max-time 3660 "$HUB_URL$poll_path" 2>/dev/null) || {
    retry_count=$((retry_count + 1))
    if [ "$retry_count" -ge "$MAX_RETRIES" ]; then
      echo "CONNECTION_ERROR: Failed to connect after $MAX_RETRIES retries" >&2
      exit 1
    fi
    sleep 5
    continue
  }

  # Extract HTTP status code (last line) and body (everything else)
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  case "$http_code" in
    200)
      # Parse JSON and format messages using python3 (macOS built-in).
      # Scope OFF errexit around the pipe: with `set -e`, a non-zero python exit aborts
      # the script right here (errexit fires on the pipeline's exit status), so the
      # `case "$py_exit"` below was never reached for empty/killed/parse-fail — making
      # those branches dead code. Disabling errexit just for the pipe makes the case work.
      set +e
      echo "$body" | python3 -c "
import sys, json, os, base64, tempfile, datetime

MIME_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
}

# At-least-once client state (only when RADIO_CURSOR_FILE is set; see radio-wait.sh header).
CURSOR_FILE = os.environ.get('RADIO_CURSOR_FILE') or ''
SEEN_FILE = os.environ.get('RADIO_SEEN_FILE') or ''
SEEN_CAP = 500  # bound the dedup memory; older ids age out (the cursor prevents their re-fetch)

try:
    data = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    print('ERROR: Invalid JSON response', file=sys.stderr)
    sys.exit(1)

messages = data.get('messages', [])
resp_cursor = data.get('cursor')

def advance_cursor():
    # Persist the server's returned cursor (the ack: next poll asks for messages after it).
    # Best-effort; a failed write just means the same window is re-fetched and deduped.
    if CURSOR_FILE and resp_cursor is not None:
        try:
            with open(CURSOR_FILE, 'w') as f:
                f.write(str(resp_cursor))
        except OSError:
            pass

# A kill is a control signal, not deduped content: honor it whenever it appears.
for m in messages:
    if m.get('content', '').startswith('RADIO_KILLED:'):
        print('RADIO_KILLED')
        sys.exit(3)

# Dedup by id in cursor mode: at-least-once means a redelivered (already-appended) message
# can arrive again; surface only ids we haven't seen. Legacy mode surfaces everything.
if CURSOR_FILE:
    seen = []
    if SEEN_FILE and os.path.exists(SEEN_FILE):
        try:
            with open(SEEN_FILE) as f:
                seen = [line.strip() for line in f if line.strip()]
        except OSError:
            seen = []
    seen_set = set(seen)
    fresh = [m for m in messages if m.get('id') not in seen_set]
else:
    seen = []
    fresh = messages

if not fresh:
    # Empty poll, or every message was a dupe: nothing to surface. Advance past this window
    # (we have it) and let the caller re-poll. Exit 2 == 'continue' in the shell case.
    advance_cursor()
    sys.exit(2)

for m in fresh:
    from_user = m.get('from', '?')
    to_user = m.get('to', '?')
    content = m.get('content', '')
    channel = m.get('channel', '#all')
    ts = m.get('timestamp', 0)

    try:
        t = datetime.datetime.fromtimestamp(ts / 1000)
        time_str = t.strftime('%H:%M:%S')
    except (OSError, ValueError):
        time_str = '??:??:??'

    image_info = ''
    img = m.get('image')
    if img:
        mime = img.get('mimeType', 'image/png')
        ext = MIME_EXT.get(mime, '.png')
        img_data = base64.b64decode(img.get('data', ''))
        fd, path = tempfile.mkstemp(suffix=ext, prefix='walkie-img-')
        os.write(fd, img_data)
        os.close(fd)
        image_info = f' [image: {path}]'

    print(f'[{time_str}] {channel} {from_user} -> {to_user}: {content}{image_info}')

# Cursor mode: record the surfaced ids (bounded) and advance the cursor AFTER printing, so
# the ack only moves once these messages have actually been emitted to the caller.
if CURSOR_FILE:
    if SEEN_FILE:
        new_seen = seen + [m.get('id') for m in fresh if m.get('id')]
        new_seen = new_seen[-SEEN_CAP:]
        try:
            with open(SEEN_FILE, 'w') as f:
                f.write('\n'.join(new_seen) + '\n')
        except OSError:
            pass
    advance_cursor()
"
      py_exit=$?
      set -e
      case "$py_exit" in
        0) exit 0 ;;       # Messages printed successfully
        2) continue ;;     # Empty messages, retry poll
        3) exit 1 ;;       # RADIO_KILLED
        *)
          # Parse/processing failure on a 200 body (invalid or truncated JSON, bad
          # image, etc.). The hub already drained these message(s) from the queue when
          # it sent the 200, so they are CONSUMED but undelivered. Exiting 1 with empty
          # stdout here is indistinguishable from a connection outage, so radio-listen
          # would silently retry and the message would be lost without a trace (the
          # "consume-and-drop" / silent-inbox-stall the fleet hit). Instead emit a LOUD,
          # DISTINCT marker on stdout (so radio-listen surfaces it instead of silent-
          # retrying, and a raw caller sees it) and exit 4 (distinct from outage's 1).
          # Dump the raw unparseable body for diagnosis (is it truncated vs valid-but-huge?
          # an incomplete-JSON dump = transport truncation). Keyed by pid+epoch so concurrent
          # / repeated failures don't collide. Best-effort; never let the dump itself fail us.
          dump="/tmp/radio-parsefail-$$-$(date +%s).raw"
          printf '%s' "$body" > "$dump" 2>/dev/null || dump="(dump failed)"
          echo "RADIO_PARSE_ERROR: /poll returned a 200 body that did not parse (possibly truncated) - a message was likely consumed but NOT delivered; re-check radio_check/inbox and ask the sender to re-send if something is missing. Raw body saved to $dump"
          exit 4
          ;;
      esac
      ;;
    204)
      # Poll timeout, retry
      retry_count=0
      continue
      ;;
    401)
      echo "RADIO_KILLED"
      exit 1
      ;;
    *)
      retry_count=$((retry_count + 1))
      if [ "$retry_count" -ge "$MAX_RETRIES" ]; then
        echo "ERROR: HTTP $http_code after $MAX_RETRIES retries" >&2
        exit 1
      fi
      sleep 5
      ;;
  esac
done

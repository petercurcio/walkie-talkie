import type { IncomingMessage, ServerResponse } from "node:http";
import { dbGetDeliveriesAfter } from "./db.js";
import { drainQueue } from "./router.js";
import type { PendingPoll } from "./types.js";

const POLL_TIMEOUT_MS = 3_600_000; // 1 hour
const pendingPolls = new Map<string, PendingPoll>();

// Track users explicitly detected as offline (poll connection dropped).
// Registered users NOT in this set are considered online (default = online).
const offlineUsers = new Set<string>();

// Per-subscriber last-seen: epoch ms of the user's most recent poll. Lets a
// silently-dead subscriber (listener wedged/killed → no recent poll) be detected
// via /users, instead of looking identical to an idle-but-healthy channel.
const lastSeen = new Map<string, number>();

let onDisconnectCallback: ((userName: string) => void) | null = null;

export function onPollDisconnect(cb: (userName: string) => void): void {
  onDisconnectCallback = cb;
}

export function isOnline(userName: string): boolean {
  return !offlineUsers.has(userName);
}

export function setOnline(userName: string): void {
  offlineUsers.delete(userName);
}

export function setOffline(userName: string): void {
  offlineUsers.add(userName);
}

/** Epoch ms of the user's most recent poll, or null if they have never polled. */
export function getLastSeen(userName: string): number | null {
  return lastSeen.get(userName) ?? null;
}

/**
 * Stamp the user's last-seen now, for poll paths that don't go through addPoll (the
 * cursor=init bootstrap responds immediately without registering a pending poll, but it's
 * still a real poll that proves the listener is alive).
 */
export function recordSeen(userName: string): void {
  lastSeen.set(userName, Date.now());
}

/** True if the user currently has a live long-poll connection open. */
export function hasActivePoll(userName: string): boolean {
  return pendingPolls.has(userName);
}

/**
 * Register a long-poll for `userName`. When `cursor` is a number, the poll is resolved in
 * serve-by-cursor (at-least-once) mode: messages are read from the persisted delivery log
 * after that cursor and are NOT removed, so a lost/unparsed 200 recovers on the next poll
 * with the same cursor. When `cursor` is undefined, the legacy drain path (at-most-once) is
 * used unchanged, so any client that doesn't send a cursor keeps its prior behavior.
 */
export function addPoll(userName: string, req: IncomingMessage, res: ServerResponse, cursor?: number): void {
  removePoll(userName);
  lastSeen.set(userName, Date.now());

  console.log(`[poll-start] ${userName} waiting for messages...`);

  const timer = setTimeout(() => {
    pendingPolls.delete(userName);
    console.log(`[poll-timeout] ${userName} (no messages after ${POLL_TIMEOUT_MS / 1000}s)`);
    res.writeHead(204);
    res.end();
  }, POLL_TIMEOUT_MS);

  pendingPolls.set(userName, { userName, res, timer, cursor });

  // Detect unexpected connection drop (agent crash, network loss).
  // Listen on req (not res) — more reliable when no response has been written yet.
  req.on("close", () => {
    if (!res.writableEnded && pendingPolls.has(userName)) {
      console.log(`[poll-disconnect] ${userName} connection dropped`);
      clearTimeout(timer);
      pendingPolls.delete(userName);
      onDisconnectCallback?.(userName);
    }
  });

  // Immediate check: deliver anything already available so the client doesn't wait.
  if (cursor !== undefined) {
    const { messages, cursor: newCursor } = dbGetDeliveriesAfter(userName, cursor);
    if (messages.length > 0) {
      clearTimeout(timer);
      pendingPolls.delete(userName);
      drainQueue(userName); // discard the parallel in-memory queue; the log is authoritative
      console.log(`[poll-immediate] ${userName} <- ${messages.length} message(s) (cursor ${cursor}->${newCursor})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages, cursor: newCursor }));
    }
    return;
  }

  // Legacy at-most-once: drain the in-memory queue.
  const messages = drainQueue(userName);
  if (messages.length > 0) {
    clearTimeout(timer);
    pendingPolls.delete(userName);
    console.log(`[poll-immediate] ${userName} <- ${messages.length} queued message(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
  }
}

export function deliverMessage(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (!poll) return;

  // Serve-by-cursor wake: re-query the delivery log after the poll's cursor.
  if (poll.cursor !== undefined) {
    const { messages, cursor: newCursor } = dbGetDeliveriesAfter(userName, poll.cursor);
    if (messages.length === 0) return;

    clearTimeout(poll.timer);
    pendingPolls.delete(userName);
    drainQueue(userName); // discard the parallel in-memory queue; the log is authoritative
    console.log(`[poll-deliver] ${userName} <- ${messages.length} message(s) (cursor ${poll.cursor}->${newCursor})`);

    poll.res.writeHead(200, { "Content-Type": "application/json" });
    poll.res.end(JSON.stringify({ messages, cursor: newCursor }));
    return;
  }

  // Legacy at-most-once wake.
  const messages = drainQueue(userName);
  if (messages.length === 0) return;

  clearTimeout(poll.timer);
  pendingPolls.delete(userName);

  for (const m of messages) {
    if (m.image) {
      console.log(`[poll-deliver] ${userName} <- image (${m.image.mimeType}, ${m.image.data.length} chars base64)`);
    }
  }
  console.log(`[poll-deliver] ${userName} <- ${messages.length} message(s)`);

  poll.res.writeHead(200, { "Content-Type": "application/json" });
  poll.res.end(JSON.stringify({ messages }));
}

export function closeAllPolls(): void {
  for (const [, poll] of pendingPolls) {
    clearTimeout(poll.timer);
    if (!poll.res.writableEnded) {
      poll.res.writeHead(204);
      poll.res.end();
    }
  }
  pendingPolls.clear();
}

export function removePoll(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (poll) {
    clearTimeout(poll.timer);
    pendingPolls.delete(userName);
    if (!poll.res.writableEnded) {
      poll.res.writeHead(204);
      poll.res.end();
    }
  }
}

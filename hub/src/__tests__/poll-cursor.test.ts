import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function send(token: string, to: string, content: string): Promise<void> {
  const res = await fetch(`${ctx.baseUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, content }),
  });
  if (res.status !== 200) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

type PollResult = { status: number; messages: Array<{ id: string; content: string }>; cursor?: number };

/**
 * Poll guarded by a timeout so an empty long-poll (which the hub holds open for up to an
 * hour) fails the test fast instead of hanging. `cursor` omitted → no query param (legacy
 * drain path); a number or "init" → the serve-by-cursor path.
 */
async function poll(token: string, cursor?: number | "init", timeoutMs = 2000): Promise<PollResult> {
  const path = cursor === undefined ? "/poll" : `/poll?cursor=${cursor}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    if (res.status === 204) return { status: 204, messages: [] };
    const body = (await res.json()) as { messages: Array<{ id: string; content: string }>; cursor?: number };
    return { status: res.status, messages: body.messages, cursor: body.cursor };
  } catch {
    return { status: 0, messages: [] }; // aborted (timed out / hung)
  } finally {
    clearTimeout(t);
  }
}

describe("/poll serve-by-cursor (at-least-once delivery)", () => {
  it("serves messages after the cursor and returns an advancing cursor", async () => {
    const alice = await registerUser(ctx, "pc-alice1");
    const bob = await registerUser(ctx, "pc-bob1");
    await send(alice, "@pc-bob1", "one");
    await send(alice, "@pc-bob1", "two");

    const r = await poll(bob, 0);
    expect(r.status).toBe(200);
    expect(r.messages.map((m) => m.content)).toEqual(["one", "two"]);
    expect(r.cursor).toBeGreaterThan(0);
  });

  it("serves only messages after the supplied cursor", async () => {
    const alice = await registerUser(ctx, "pc-alice2");
    const bob = await registerUser(ctx, "pc-bob2");
    await send(alice, "@pc-bob2", "one");
    const first = await poll(bob, 0);
    expect(first.messages.map((m) => m.content)).toEqual(["one"]);

    await send(alice, "@pc-bob2", "two");
    const second = await poll(bob, first.cursor!);
    expect(second.messages.map((m) => m.content)).toEqual(["two"]);
    expect(second.cursor!).toBeGreaterThan(first.cursor!);
  });

  it("re-delivers the same messages when the cursor is NOT advanced (lost-200 / unacked)", async () => {
    // The core at-least-once property: polling the SAME cursor twice returns the same
    // messages — the hub does not drain/discard on send. A lost or unparsed 200 recovers.
    const alice = await registerUser(ctx, "pc-alice3");
    const bob = await registerUser(ctx, "pc-bob3");
    await send(alice, "@pc-bob3", "one");
    await send(alice, "@pc-bob3", "two");

    const a = await poll(bob, 0);
    const b = await poll(bob, 0);
    expect(a.messages.map((m) => m.content)).toEqual(["one", "two"]);
    expect(b.messages.map((m) => m.content)).toEqual(["one", "two"]);
    expect(b.cursor).toBe(a.cursor);
  });

  it("cursor=init establishes the high-water mark with no backlog", async () => {
    const alice = await registerUser(ctx, "pc-alice4");
    const bob = await registerUser(ctx, "pc-bob4");
    await send(alice, "@pc-bob4", "one");
    await send(alice, "@pc-bob4", "two");

    const init = await poll(bob, "init");
    expect(init.status).toBe(200);
    expect(init.messages).toEqual([]);
    expect(init.cursor!).toBeGreaterThan(0);

    // Only messages after the established mark are served going forward.
    await send(alice, "@pc-bob4", "three");
    const next = await poll(bob, init.cursor!);
    expect(next.messages.map((m) => m.content)).toEqual(["three"]);
  });

  it("wakes a waiting cursor poll when a new message arrives (long-poll)", async () => {
    const alice = await registerUser(ctx, "pc-alice5");
    const bob = await registerUser(ctx, "pc-bob5");
    const init = await poll(bob, "init");

    // Open the long-poll, then send after a beat; it should resolve with the new message.
    const pending = poll(bob, init.cursor!, 5000);
    await new Promise((r) => setTimeout(r, 200));
    await send(alice, "@pc-bob5", "live");
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.messages.map((m) => m.content)).toEqual(["live"]);
    expect(r.cursor!).toBeGreaterThan(init.cursor!);
  });

  it("legacy no-cursor poll still drains at-most-once (backward compatible)", async () => {
    const alice = await registerUser(ctx, "pc-alice6");
    const bob = await registerUser(ctx, "pc-bob6");
    await send(alice, "@pc-bob6", "one");
    const first = await poll(bob); // no cursor → legacy drain
    expect(first.messages.map((m) => m.content)).toEqual(["one"]);
    expect(first.cursor).toBeUndefined();

    // Drained: a fresh message is returned alone, not re-accompanied by "one".
    await send(alice, "@pc-bob6", "two");
    const second = await poll(bob);
    expect(second.messages.map((m) => m.content)).toEqual(["two"]);
  });
});

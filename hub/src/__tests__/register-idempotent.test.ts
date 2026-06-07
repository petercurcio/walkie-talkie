import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function register(name: string, oldToken?: string): Promise<{ status: number; token?: string }> {
  const body: { name: string; oldToken?: string } = { name };
  if (oldToken) body.oldToken = oldToken;
  const res = await fetch(`${ctx.baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { token?: string };
  return { status: res.status, token: j.token };
}

describe("register idempotency (re-join by the proven owner keeps the same token)", () => {
  it("returns the SAME token when re-joining with the matching oldToken (no rotation)", async () => {
    const first = await register("idem-keep");
    expect(first.status).toBe(200);
    expect(first.token).toBeTruthy();

    const again = await register("idem-keep", first.token);
    expect(again.status).toBe(200);
    // The token MUST NOT rotate — a still-running listener on this token must stay valid,
    // instead of being orphaned (401) by every re-join, which drove the re-arm churn.
    expect(again.token).toBe(first.token);
  });

  it("does NOT disrupt the owner's in-flight long-poll on an idempotent re-join", async () => {
    const reg = await register("idem-poll");
    const token = reg.token!;

    // Open a long-poll (held open; nothing to deliver yet).
    const ac = new AbortController();
    let pollSettledEarly = false;
    fetch(`${ctx.baseUrl}/poll`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then(() => {
        pollSettledEarly = true;
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 150));

    // Owner re-joins with the matching token — the held poll should remain open.
    const again = await register("idem-poll", token);
    expect(again.token).toBe(token);
    await new Promise((r) => setTimeout(r, 150));
    expect(pollSettledEarly).toBe(false); // the live listener was not 204'd / disrupted

    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("still rejects a no-proof re-join of an actively-polling registration (409)", async () => {
    const reg = await register("idem-guard");
    const token = reg.token!;
    const ac = new AbortController();
    fetch(`${ctx.baseUrl}/poll`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));

    // No oldToken: an unproven caller cannot steal a live registration.
    const stolen = await register("idem-guard");
    expect(stolen.status).toBe(409);

    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
  });
});

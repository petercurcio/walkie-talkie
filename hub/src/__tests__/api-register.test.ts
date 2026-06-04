import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("POST /register", () => {
  it("should register a new user and return a token", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-alice" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-alice");
    expect(body.token).toBeTruthy();
  });

  it("should reject duplicate registration", async () => {
    await registerUser(ctx, "reg-dup");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-dup" }),
    });
    expect(res.status).toBe(409);
  });

  it("should allow reconnect with old token", async () => {
    const token = await registerUser(ctx, "reg-reconnect");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-reconnect", oldToken: token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-reconnect");
    // New token should be different
    expect(body.token).toBeTruthy();
  });

  it("should reject reconnect with wrong old token", async () => {
    await registerUser(ctx, "reg-wrongtoken");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-wrongtoken", oldToken: "wrong" }),
    });
    expect(res.status).toBe(409);
  });

  // Drive a registered user offline by opening a poll and aborting it, so the hub
  // sees the connection drop (poll-disconnect -> setOffline), as if the prior
  // session's process died / its MCP server reconnected.
  async function goOffline(token: string): Promise<void> {
    const ac = new AbortController();
    fetch(`${ctx.baseUrl}/poll`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
  }

  it("reclaims a STALE (offline) registration without an old token", async () => {
    // The reconnect-deadlock fix: a fresh session can take over a name whose prior
    // session is gone (offline = no active poll), without an operator kick.
    const token = await registerUser(ctx, "reg-stale");
    await goOffline(token);

    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "reg-stale" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-stale");
    expect(body.token).not.toBe(token); // fresh token issued
  });

  it("still rejects takeover of an ONLINE registration without an old token", async () => {
    // A genuinely-live session (active/just-registered = online) must NOT be
    // reclaimable without proving ownership — only stale ones are.
    await registerUser(ctx, "reg-online"); // register -> online
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "reg-online" }),
    });
    expect(res.status).toBe(409);
  });

  it("preserves queued messages across a stale reclaim (no loss on reconnect)", async () => {
    // The message-loss fix: messages that arrived while the prior session was
    // offline survive the reconnect (previously an operator kick cleared the queue).
    const token = await registerUser(ctx, "reg-qsave");
    await goOffline(token);

    const senderToken = await registerUser(ctx, "reg-qsender");
    await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "@reg-qsave", content: "queued-while-offline", channel: "#all" }),
    });

    const reclaim = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "reg-qsave" }),
    });
    const { token: newToken } = (await reclaim.json()) as { token: string };

    const inbox = (await (
      await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${newToken}` } })
    ).json()) as { messages: { content: string }[] };
    expect(inbox.messages.some((m) => m.content === "queued-while-offline")).toBe(true);
  });

  it("should reject missing name", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /unregister", () => {
  it("should unregister an authenticated user", async () => {
    const token = await registerUser(ctx, "reg-unreg");
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    // Should no longer appear in users list
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const usersBody = (await usersRes.json()) as { users: { name: string }[] };
    expect(usersBody.users.map((u) => u.name)).not.toContain("reg-unreg");
  });

  it("should reject unregister without token", async () => {
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

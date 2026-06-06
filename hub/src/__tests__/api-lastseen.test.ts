import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

type UserRow = { name: string; online: boolean; role: string; lastSeen: number | null; hasActivePoll: boolean };

async function getUsers(): Promise<UserRow[]> {
  const res = await fetch(`${ctx.baseUrl}/users`);
  return ((await res.json()) as { users: UserRow[] }).users;
}

describe("/users lastSeen (silently-dead subscriber detection)", () => {
  it("is null for a registered user who has never polled", async () => {
    await registerUser(ctx, "ls-never");
    const u = (await getUsers()).find((x) => x.name === "ls-never");
    expect(u).toBeTruthy();
    expect(u!.lastSeen).toBeNull();
  });

  it("reports hasActivePoll true only while a poll is open (true liveness, vs stale lastSeen)", async () => {
    const token = await registerUser(ctx, "hap-user");

    // No open poll yet.
    let u = (await getUsers()).find((x) => x.name === "hap-user");
    expect(u?.hasActivePoll).toBe(false);

    // Open a long-poll; while held, hasActivePoll is true.
    const ac = new AbortController();
    fetch(`${ctx.baseUrl}/poll`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    u = (await getUsers()).find((x) => x.name === "hap-user");
    expect(u?.hasActivePoll).toBe(true);

    // Once the poll closes, it drops back to false.
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
    u = (await getUsers()).find((x) => x.name === "hap-user");
    expect(u?.hasActivePoll).toBe(false);
  });

  it("is a recent timestamp after the user polls", async () => {
    const token = await registerUser(ctx, "ls-polled");
    const before = Date.now();

    // Open a poll to trigger addPoll (which stamps lastSeen), then abort it.
    const ac = new AbortController();
    fetch(`${ctx.baseUrl}/poll`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();

    const u = (await getUsers()).find((x) => x.name === "ls-polled");
    expect(u?.lastSeen).toBeTruthy();
    expect(u!.lastSeen!).toBeGreaterThanOrEqual(before);
    expect(u!.lastSeen!).toBeLessThanOrEqual(Date.now());
  });
});

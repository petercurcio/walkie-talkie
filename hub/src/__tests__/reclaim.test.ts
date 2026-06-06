import { describe, expect, it, beforeAll } from "vitest";

// server.js pulls in db-touching modules on import; route them to in-memory (matches the
// other hub tests).
process.env.WALKIE_TALKIE_DB_PATH = ":memory:";

let canReclaimRegistration: (opts: {
  ownsToken: boolean;
  online: boolean;
  hasActivePoll: boolean;
  lastSeen: number | null;
  now: number;
  staleMs: number;
}) => boolean;

beforeAll(async () => {
  ({ canReclaimRegistration } = await import("../server.js"));
});

const NOW = 1_000_000;
const STALE = 60_000;
const base = { ownsToken: false, online: true, hasActivePoll: false, lastSeen: NOW, now: NOW, staleMs: STALE };

describe("canReclaimRegistration", () => {
  it("allows reclaim when the caller proves ownership (any state)", () => {
    expect(canReclaimRegistration({ ...base, ownsToken: true, online: true, hasActivePoll: true })).toBe(true);
  });

  it("allows reclaim when the prior session is offline (poll dropped)", () => {
    expect(canReclaimRegistration({ ...base, online: false })).toBe(true);
  });

  it("BLOCKS reclaim of a live listener with an active poll", () => {
    expect(canReclaimRegistration({ ...base, online: true, hasActivePoll: true })).toBe(false);
  });

  it("BLOCKS reclaim during a re-arm gap (online, no poll, but recent lastSeen)", () => {
    expect(canReclaimRegistration({ ...base, online: true, hasActivePoll: false, lastSeen: NOW - 10_000 })).toBe(false);
  });

  it("BLOCKS reclaim of a fresh just-registered session (online, no poll, no lastSeen yet)", () => {
    expect(canReclaimRegistration({ ...base, online: true, hasActivePoll: false, lastSeen: null })).toBe(false);
  });

  it("ALLOWS reclaim of an abandoned zombie (online, no poll, stale lastSeen)", () => {
    expect(canReclaimRegistration({ ...base, online: true, hasActivePoll: false, lastSeen: NOW - 70_000 })).toBe(true);
  });

  it("treats lastSeen exactly at the threshold as not-yet-stale", () => {
    expect(canReclaimRegistration({ ...base, online: true, hasActivePoll: false, lastSeen: NOW - STALE })).toBe(false);
  });
});

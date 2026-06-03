import { describe, it, expect, beforeAll } from "vitest";

// Route DB-backed module side effects to an in-memory DB on import, matching the
// other hub tests (server.js pulls in db-touching modules transitively).
process.env.WALKIE_TALKIE_DB_PATH = ":memory:";

let resolveStaleGraceMs: (env?: NodeJS.ProcessEnv) => number;

beforeAll(async () => {
  ({ resolveStaleGraceMs } = await import("../server.js"));
});

describe("resolveStaleGraceMs", () => {
  it("defaults to 30s when the env var is unset", () => {
    expect(resolveStaleGraceMs({})).toBe(30_000);
  });

  it("defaults to 30s when the env var is empty", () => {
    expect(resolveStaleGraceMs({ WALKIE_TALKIE_STALE_GRACE_MS: "" })).toBe(30_000);
  });

  it("parses a long explicit grace (e.g. 24h for a sleep-prone host)", () => {
    expect(resolveStaleGraceMs({ WALKIE_TALKIE_STALE_GRACE_MS: "86400000" })).toBe(86_400_000);
  });

  it("treats 0 as the disable sentinel (<= 0)", () => {
    expect(resolveStaleGraceMs({ WALKIE_TALKIE_STALE_GRACE_MS: "0" })).toBe(0);
  });

  it("passes through a negative value (also disables, <= 0)", () => {
    expect(resolveStaleGraceMs({ WALKIE_TALKIE_STALE_GRACE_MS: "-1" })).toBe(-1);
  });

  it("falls back to the default on a non-numeric value", () => {
    expect(resolveStaleGraceMs({ WALKIE_TALKIE_STALE_GRACE_MS: "abc" })).toBe(30_000);
  });

  it("reads the real process.env by default", () => {
    // Not set in this suite's env -> default. Asserts the no-arg path works.
    expect(resolveStaleGraceMs()).toBe(30_000);
  });
});

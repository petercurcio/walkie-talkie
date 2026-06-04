import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import { HubClient } from "../client.js";

/**
 * Regression for the radio_standby hang: poll() used a 1-hour timeout, so when no
 * message arrived radio_standby blocked ~an hour, exceeded the MCP client's
 * tool-call timeout, and the whole walkie-talkie MCP server was dropped as
 * unresponsive ("No such tool available"). poll() must now return promptly with
 * null on a bounded timeout instead of blocking or throwing.
 */
describe("HubClient.poll bounded timeout", () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function listen(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(0, r));
    return (server!.address() as { port: number }).port;
  }

  it("returns null promptly when the poll times out with no message (no hang, no throw)", async () => {
    // Stub hub holds the connection open and never responds, like a long-poll
    // with no queued message.
    const port = await listen(() => {
      /* intentionally never respond */
    });
    const client = new HubClient(`http://localhost:${port}`);

    const start = Date.now();
    const result = await client.poll("test-token", 150); // short bound for the test
    const elapsed = Date.now() - start;

    expect(result).toBeNull(); // timeout is "no messages", not an error
    expect(elapsed).toBeLessThan(2000); // returned at the bound, not an hour
  });

  it("returns delivered messages on a 200 response", async () => {
    const msg = { id: "1", from: "a", to: "skills", content: "hi", channel: "#all", timestamp: 1 };
    const port = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: [msg] }));
    });
    const client = new HubClient(`http://localhost:${port}`);

    const result = await client.poll("test-token", 5000);
    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0].content).toBe("hi");
  });

  it("returns null on a 204 (hub-side poll timeout)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const client = new HubClient(`http://localhost:${port}`);

    expect(await client.poll("test-token", 5000)).toBeNull();
  });
});

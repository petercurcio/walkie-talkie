import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { HubClient } from "../client.js";

/**
 * send() must ride out a brief hub-unreachable window (e.g. a ~30s hub restart drops every
 * listener AND refuses sends). Before this, a send during that window failed instantly and the
 * message silently vanished — never recorded, unrecoverable by delivery-ack (it never reached
 * the hub). Now connection-class failures retry on a bounded backoff. A response the hub DID
 * return (a real non-2xx) is terminal and must NOT be retried (no duplicate sends).
 */
describe("HubClient.send retry on hub-unreachable", () => {
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

  it("retries a dropped connection and succeeds once the hub returns", async () => {
    let n = 0;
    const port = await listen((req, res) => {
      n++;
      if (n === 1) {
        req.socket.destroy(); // simulate the hub mid-restart: connection reset, no response
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "m1", to: "bob" }));
    });
    const client = new HubClient(`http://localhost:${port}`, { retryBackoffsMs: [10] });

    const r = await client.send("tok", "@bob", "hi");
    expect(r.id).toBe("m1");
    expect(n).toBe(2); // first reset, retried, second delivered
  });

  it("does NOT retry a real non-2xx response (terminal, no duplicate send)", async () => {
    let n = 0;
    const port = await listen((_req, res) => {
      n++;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "User \"bob\" is not connected" }));
    });
    const client = new HubClient(`http://localhost:${port}`, { retryBackoffsMs: [10, 10, 10] });

    await expect(client.send("tok", "@bob", "hi")).rejects.toThrow(/not connected/i);
    expect(n).toBe(1); // a legitimate 404 is not retried
  });

  it("gives a clear 'hub unreachable' error after exhausting retries", async () => {
    let n = 0;
    const port = await listen((req) => {
      n++;
      req.socket.destroy(); // always down
    });
    const client = new HubClient(`http://localhost:${port}`, { retryBackoffsMs: [5, 5] });

    await expect(client.send("tok", "@bob", "hi")).rejects.toThrow(/hub unreachable/i);
    expect(n).toBe(3); // initial try + 2 retries
  });
});

import http from "node:http";
import https from "node:https";

interface RequestOptions {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface HubResponse<T = unknown> {
  status: number;
  data: T;
}

export class HubClient {
  private baseUrl: URL;
  private retryBackoffsMs: number[];

  constructor(hubUrl: string, opts?: { retryBackoffsMs?: number[] }) {
    this.baseUrl = new URL(hubUrl);
    // Backoff schedule for send retries on hub-unreachable. ~15s total across 4 retries —
    // long enough to ride out a brief hub restart, short enough to stay well under the MCP
    // tool-call timeout (a too-long block drops the whole MCP server, cf. radio_standby).
    this.retryBackoffsMs = opts?.retryBackoffsMs ?? [1000, 2000, 4000, 8000];
  }

  getBaseUrl(): string {
    return this.baseUrl.toString().replace(/\/$/, "");
  }

  private request<T>(options: RequestOptions): Promise<HubResponse<T>> {
    return new Promise((resolve, reject) => {
      const isHttps = this.baseUrl.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {};
      if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
      }

      let bodyStr: string | undefined;
      if (options.body !== undefined) {
        bodyStr = JSON.stringify(options.body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }

      const req = transport.request(
        {
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port,
          path: options.path,
          method: options.method,
          headers,
          timeout: options.timeoutMs ?? 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            const status = res.statusCode ?? 0;
            if (status === 204 || raw.length === 0) {
              resolve({ status, data: {} as T });
              return;
            }
            try {
              resolve({ status, data: JSON.parse(raw) as T });
            } catch {
              reject(new Error(`Invalid JSON response: ${raw}`));
            }
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * Like request(), but retries connection-class failures (refused / reset / timeout) on a
   * bounded backoff. Closes the "a send during a hub restart silently vanishes" gap: a brief
   * hub-down window is ridden out instead of failing instantly. Crucially, it does NOT retry
   * a response the hub actually returned — a resolved non-2xx (e.g. 404 user-not-connected)
   * comes back so the caller can throw it terminally, and an "Invalid JSON" (hub responded,
   * send likely processed) is re-thrown without retry, so we never duplicate a send the hub
   * already accepted.
   */
  private async requestWithRetry<T>(options: RequestOptions): Promise<HubResponse<T>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retryBackoffsMs.length; attempt++) {
      try {
        return await this.request<T>(options);
      } catch (e) {
        lastErr = e;
        if ((e as Error).message?.startsWith("Invalid JSON response")) throw e;
        if (attempt < this.retryBackoffsMs.length) {
          await new Promise((r) => setTimeout(r, this.retryBackoffsMs[attempt]));
          continue;
        }
      }
    }
    throw new Error(`hub unreachable, send not delivered (after ${this.retryBackoffsMs.length} retries): ${(lastErr as Error).message}`);
  }

  async register(name: string, joinToken: string, oldToken?: string): Promise<{ token: string; name: string }> {
    const body: { name: string; oldToken?: string } = { name };
    if (oldToken) body.oldToken = oldToken;
    const res = await this.request<{ token: string; name: string }>({
      method: "POST",
      path: "/register",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Registration failed");
    }
    return res.data;
  }

  async unregister(token: string): Promise<void> {
    await this.request({
      method: "POST",
      path: "/unregister",
      token,
    });
  }

  async send(
    token: string,
    to: string,
    content: string,
    channel?: string,
    image?: { data: string; mimeType: string },
  ): Promise<{ id: string; to: string }> {
    const body: { to: string; content: string; channel?: string; image?: { data: string; mimeType: string } } = {
      to,
      content,
    };
    if (channel) body.channel = channel;
    if (image) body.image = image;
    const res = await this.requestWithRetry<{ id: string; to: string }>({
      method: "POST",
      path: "/send",
      token,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Send failed");
    }
    return res.data;
  }

  /**
   * Bounded long-poll for radio_standby. timeoutMs MUST stay well under the MCP
   * client's tool-call timeout: this runs as an MCP tool, and if the call blocks
   * longer than that timeout the whole MCP server is dropped as unresponsive
   * ("No such tool available"). The hub holds /poll open for up to an hour, so a
   * too-long value here meant radio_standby could hang ~an hour and take the MCP
   * connection down with it. 30s matches the tool's documented "blocks up to 30
   * seconds" and stays under the default 60s MCP timeout.
   *
   * A timeout with no message is the NORMAL "no messages" outcome, not an error,
   * so we resolve it to null (radio_standby then reports "no new messages")
   * rather than throwing — throwing would surface as a tool error / dropped call.
   */
  async poll(
    token: string,
    timeoutMs = 30_000,
  ): Promise<{
    messages: Array<{
      id: string;
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: { data: string; mimeType: string };
    }>;
  } | null> {
    try {
      const res = await this.request<{
        messages: Array<{
          id: string;
          from: string;
          to: string;
          content: string;
          channel: string;
          timestamp: number;
          image?: { data: string; mimeType: string };
        }>;
      }>({
        method: "GET",
        path: "/poll",
        token,
        timeoutMs,
      });
      if (res.status === 204) return null;
      if (res.status !== 200) {
        throw new Error((res.data as { error?: string }).error ?? "Poll failed");
      }
      return res.data;
    } catch (e) {
      if (e instanceof Error && e.message === "Request timed out") return null;
      throw e;
    }
  }

  async inbox(token: string): Promise<{
    messages: Array<{
      id: string;
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: { data: string; mimeType: string };
    }>;
  }> {
    const res = await this.request<{
      messages: Array<{
        id: string;
        from: string;
        to: string;
        content: string;
        channel: string;
        timestamp: number;
        image?: { data: string; mimeType: string };
      }>;
    }>({
      method: "GET",
      path: "/inbox",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Inbox fetch failed");
    }
    return res.data;
  }

  async users(token: string): Promise<Array<{ name: string; online: boolean; role: string }>> {
    // The hub's GET /users returns objects ({ name, online, role }), not bare
    // strings — see hub handleUsers + its api-register/api-admin tests. The
    // prior `string[]` typing was wrong and caused callers to render
    // "[object Object]" when joining the array.
    const res = await this.request<{ users: Array<{ name: string; online: boolean; role: string }> }>({
      method: "GET",
      path: "/users",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to get users");
    }
    return res.data.users;
  }

  async listChannels(token: string): Promise<Array<{ name: string; memberCount: number; createdBy: string }>> {
    const res = await this.request<{ channels: Array<{ name: string; memberCount: number; createdBy: string }> }>({
      method: "GET",
      path: "/channels",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to list channels");
    }
    return res.data.channels;
  }

  async createChannel(token: string, name: string): Promise<{ channel: string }> {
    const res = await this.request<{ ok: boolean; channel: string }>({
      method: "POST",
      path: "/channel-create",
      token,
      body: { name },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to create channel");
    }
    return { channel: res.data.channel };
  }

  async joinChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-join",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to join channel");
    }
  }

  async leaveChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-leave",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to leave channel");
    }
  }

  async inviteToChannel(token: string, channel: string, user: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-invite",
      token,
      body: { channel, user },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to invite user to channel");
    }
  }
}

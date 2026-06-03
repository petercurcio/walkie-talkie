import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  authenticateRequest,
  getRegisteredUsers,
  getUserRole,
  getUserToken,
  isUserRegistered,
  registerUser,
  unregisterUser,
} from "./auth.js";
import {
  ensureChannelMembership,
  getChannelMemberCounts,
  getChannelMembers,
  isChannelMember,
  joinChannel,
  leaveChannel,
  removeChannel,
} from "./channels.js";
import { getDashboardHTML } from "./dashboard.js";
import {
  dbCreateAgentConfig,
  dbCreateChannel,
  dbDeleteAgentConfig,
  dbDeleteChannel,
  dbDeleteChannelMessages,
  dbDeleteReadCursorsForChannel,
  dbGetAgentConfig,
  dbGetChannel,
  dbGetChannelMessages,
  dbGetRecentMessages,
  dbGetUnreadCounts,
  dbGetUserChannels,
  dbListAgentConfigs,
  dbListChannels,
  dbUpdateAgentConfig,
  dbUpdateReadCursor,
} from "./db.js";
import { addSSEClient, broadcast } from "./events.js";
import { launchAgent } from "./launcher.js";
import { addPoll, isOnline, onPollDisconnect, removePoll, setOffline, setOnline } from "./polling.js";
import { drainQueue, enqueueAndDeliver, ensureQueue, notifyBridges, removeQueue, routeMessage } from "./router.js";
import type { RegisterRequest, RouteHandler, SendRequest } from "./types.js";

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

const handleRegister: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as RegisterRequest;
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  try {
    // Allow reconnection only if the caller proves ownership with the old token
    if (isUserRegistered(body.name)) {
      const existingToken = getUserToken(body.name);
      if (!body.oldToken || body.oldToken !== existingToken) {
        return sendError(res, 409, `User "${body.name}" is already registered`);
      }
      removePoll(body.name);
      removeQueue(body.name);
      unregisterUser(body.name);
    }
    // Cancel grace timer if reconnecting
    const graceTimer = staleTimers.get(body.name);
    if (graceTimer) {
      clearTimeout(graceTimer);
      staleTimers.delete(body.name);
    }
    const role = body.role === "bridge" ? "bridge" : "agent";
    const user = registerUser(body.name, role);
    ensureQueue(body.name);
    setOnline(body.name);
    // Auto-join #all
    try {
      joinChannel("#all", body.name);
    } catch {
      /* already joined or channel issue */
    }
    // Restore previous channel memberships from DB
    const previousChannels = dbGetUserChannels(body.name);
    for (const ch of previousChannels) {
      if (ch === "#all") continue;
      try {
        joinChannel(ch, body.name);
        broadcast({ type: "channel_join", channel: ch, userName: body.name, timestamp: Date.now() });
        console.log(`[auto-rejoin] ${body.name} -> ${ch}`);
      } catch {
        /* channel may no longer exist */
      }
    }
    broadcast({ type: "join", name: body.name, timestamp: Date.now() });
    console.log(`[register] ${body.name}`);

    if (role === "agent") {
      notifyBridges(`USER_JOINED: ${body.name}`);
    } else if (role === "bridge") {
      // Send current agent list to the newly connected bridge (even if empty)
      const agents = getRegisteredUsers().filter((n) => n !== body.name && getUserRole(n) === "agent");
      enqueueAndDeliver(body.name, {
        id: randomUUID(),
        from: "system",
        to: body.name,
        content: agents.length > 0 ? `CONNECTED_USERS: ${agents.join(", ")}` : "CONNECTED_USERS: (none)",
        channel: "#all",
        timestamp: Date.now(),
      });
    }

    sendJson(res, 200, { token: user.token, name: user.name });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleSend: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as SendRequest;
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  // Typing indicator: broadcast typing event without routing to chat log
  if (body.content === "TYPING") {
    const channel = body.channel || "#all";
    dbUpdateReadCursor(userName!, channel);
    broadcast({ type: "typing", name: userName!, channel, timestamp: Date.now() });
    console.log(`[typing] ${userName}`);
    return sendJson(res, 200, { id: "typing", to: body.to });
  }
  const content = body.content || "";
  const channel = body.channel || "#all";
  try {
    const message = routeMessage(userName!, body.to, content, channel, body.image);
    broadcast({
      type: "message",
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[send] ${userName} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    sendJson(res, 200, { id: message.id, to: message.to });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

const handleInbox: RouteHandler = async (_req, res, userName) => {
  const messages = drainQueue(userName!);
  sendJson(res, 200, { messages });
};

const handlePoll: RouteHandler = async (req, res, userName) => {
  const wasOffline = !isOnline(userName!);
  addPoll(userName!, req, res);
  if (wasOffline) {
    setOnline(userName!);
    broadcast({ type: "status", name: userName!, online: true, timestamp: Date.now() });
  }
};

const handleUsers: RouteHandler = async (_req, res) => {
  const users = getRegisteredUsers().map((name) => ({
    name,
    online: isOnline(name),
    role: getUserRole(name) ?? "agent",
  }));
  sendJson(res, 200, { users });
};

const handleUnregister: RouteHandler = async (_req, res, userName) => {
  const role = getUserRole(userName!);
  removePoll(userName!);
  removeQueue(userName!);
  unregisterUser(userName!);
  broadcast({ type: "leave", name: userName!, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(`USER_LEFT: ${userName}`);
  }
  console.log(`[unregister] ${userName}`);
  sendJson(res, 200, { ok: true });
};

function kickUser(name: string): boolean {
  if (!getRegisteredUsers().includes(name)) return false;
  const role = getUserRole(name);
  // Send a termination message directly to the target user's queue only
  ensureQueue(name);
  enqueueAndDeliver(name, {
    id: randomUUID(),
    from: "system",
    to: name,
    content: "RADIO_KILLED: You have been disconnected by the operator.",
    channel: "#all",
    timestamp: Date.now(),
  });
  removePoll(name);
  removeQueue(name);
  unregisterUser(name);
  broadcast({ type: "leave", name, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(`USER_LEFT: ${name}`);
  }
  console.log(`[kick] ${name}`);
  return true;
}

const handleKick: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name) {
    return sendError(res, 400, "Missing 'name' field");
  }
  if (kickUser(body.name)) {
    sendJson(res, 200, { ok: true, kicked: body.name });
  } else {
    sendError(res, 404, `User "${body.name}" not found`);
  }
};

const handleKickAll: RouteHandler = async (_req, res) => {
  const agents = [...getRegisteredUsers()].filter((name) => name !== "operator");
  for (const name of agents) {
    kickUser(name);
  }
  sendJson(res, 200, { ok: true, kicked: agents });
};

const handleAdminSend: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    from?: string;
    to?: string;
    content?: string;
    channel?: string;
    image?: { data: string; mimeType: string };
  };
  const from = body.from || "operator";
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  const content = body.content || "";
  const channel = body.channel || "#all";
  // Auto-register the admin sender so agents can reply
  if (!isUserRegistered(from)) {
    try {
      registerUser(from);
      ensureQueue(from);
      try {
        joinChannel("#all", from);
      } catch {
        /* already joined */
      }
      broadcast({ type: "join", name: from, timestamp: Date.now() });
      console.log(`[auto-register] ${from}`);
    } catch {
      /* already registered */
    }
  }
  // Ensure operator is in target channel
  try {
    joinChannel(channel, from);
  } catch {
    /* already joined or channel issue */
  }
  try {
    const message = routeMessage(from, body.to, content, channel, body.image);
    broadcast({
      type: "message",
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[admin-send] ${from} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    sendJson(res, 200, { id: message.id, to: message.to });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

// Channel endpoints
const handleChannelCreate: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, userName!);
    ensureChannelMembership(channelName);
    // Auto-join the creator
    joinChannel(channelName, userName!);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    broadcast({ type: "channel_join", channel: channelName, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-create] ${channelName} by ${userName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

const handleChannelJoin: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  try {
    joinChannel(body.channel, userName!);
    broadcast({ type: "channel_join", channel: body.channel, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-join] ${userName} -> ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

const handleChannelLeave: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (body.channel === "#all") {
    return sendError(res, 400, "Cannot leave #all");
  }
  leaveChannel(body.channel, userName!);
  broadcast({ type: "channel_leave", channel: body.channel, userName: userName!, timestamp: Date.now() });
  console.log(`[channel-leave] ${userName} <- ${body.channel}`);
  sendJson(res, 200, { ok: true, channel: body.channel });
};

const handleChannelInvite: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string; user?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (!body.user || typeof body.user !== "string") {
    return sendError(res, 400, "Missing or invalid 'user' field");
  }
  const targetName = body.user.startsWith("@") ? body.user.slice(1) : body.user;
  if (!isUserRegistered(targetName)) {
    return sendError(res, 404, `User "${targetName}" is not connected`);
  }
  try {
    joinChannel(body.channel, targetName);
    broadcast({ type: "channel_join", channel: body.channel, userName: targetName, timestamp: Date.now() });
    // Notify the invited user via a system message in the channel
    routeMessage("system", `@${targetName}`, `You have been invited to ${body.channel} by ${userName}`, body.channel);
    console.log(`[channel-invite] ${userName} invited ${targetName} to ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel, user: targetName });
  } catch (e) {
    sendError(res, 400, (e as Error).message);
  }
};

const handleListChannels: RouteHandler = async (_req, res) => {
  const channels = dbListChannels();
  const memberCounts = getChannelMemberCounts();
  const result = channels.map((ch) => ({
    name: ch.name,
    createdBy: ch.created_by,
    createdAt: ch.created_at,
    memberCount: memberCounts.get(ch.name) ?? 0,
    members: getChannelMembers(ch.name),
  }));
  sendJson(res, 200, { channels: result });
};

const handleChannelHistory: RouteHandler = async (req, res, userName) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  if (!channel) {
    return sendError(res, 400, "Missing 'channel' query parameter");
  }
  if (!isChannelMember(channel, userName!)) {
    return sendError(res, 403, `You are not a member of ${channel}`);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const messages = dbGetChannelMessages(channel, limit);
  sendJson(res, 200, { messages });
};

const handleAdminChannelCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, "operator");
    ensureChannelMembership(channelName);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    console.log(`[admin-channel-create] ${channelName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

const handleAdminChannelHistory: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 500);
  if (channel) {
    const messages = dbGetChannelMessages(channel, limit);
    sendJson(res, 200, { messages });
  } else {
    const messages = dbGetRecentMessages(limit);
    sendJson(res, 200, { messages });
  }
};

const handleAdminChannelDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (body.name === "#all") {
    return sendError(res, 400, "Cannot delete #all");
  }
  if (!dbGetChannel(body.name)) {
    return sendError(res, 404, `Channel "${body.name}" not found`);
  }
  dbDeleteChannel(body.name);
  dbDeleteChannelMessages(body.name);
  dbDeleteReadCursorsForChannel(body.name);
  removeChannel(body.name);
  broadcast({ type: "channel_delete", name: body.name, timestamp: Date.now() });
  console.log(`[admin-channel-delete] ${body.name}`);
  sendJson(res, 200, { ok: true, channel: body.name });
};

const handleAdminMarkRead: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string; timestamp?: number };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  const ts = body.timestamp ?? Date.now();
  dbUpdateReadCursor("operator", body.channel, ts);
  broadcast({ type: "read_update", userName: "operator", channel: body.channel, timestamp: ts });
  sendJson(res, 200, { ok: true });
};

const handleAdminUnreadCounts: RouteHandler = async (_req, res) => {
  const counts = dbGetUnreadCounts("operator");
  sendJson(res, 200, { counts });
};

// Agent config endpoints
const handleAdminAgentConfigs: RouteHandler = async (_req, res) => {
  const configs = dbListAgentConfigs();
  const result = configs.map((c) => ({
    id: c.id,
    name: c.name,
    workDir: c.work_dir,
    command: c.command,
    autoStart: c.auto_start === 1,
    envVars: c.env_vars ? JSON.parse(c.env_vars) : {},
    createdAt: c.created_at,
    online: isUserRegistered(c.name) && isOnline(c.name),
  }));
  sendJson(res, 200, { configs: result });
};

const handleAdminAgentConfigCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string>;
  };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (!AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  if (!body.workDir || typeof body.workDir !== "string") {
    return sendError(res, 400, "Missing or invalid 'workDir' field");
  }
  try {
    const id = randomUUID();
    const config = dbCreateAgentConfig(
      id,
      body.name,
      body.workDir,
      body.command || "",
      body.autoStart ?? false,
      body.envVars,
    );
    broadcast({ type: "agent_config_create", id: config.id, name: config.name, timestamp: Date.now() });
    console.log(`[agent-config-create] ${config.name}`);
    sendJson(res, 200, { ok: true, id: config.id });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleAdminAgentConfigUpdate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    id?: string;
    name?: string;
    workDir?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (body.name && !AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(config.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  dbUpdateAgentConfig(body.id, {
    name: body.name,
    workDir: body.workDir,
    autoStart: body.autoStart,
    envVars: body.envVars,
  });
  const name = body.name ?? config.name;
  broadcast({ type: "agent_config_update", id: body.id, name, timestamp: Date.now() });
  console.log(`[agent-config-update] ${name}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentConfigDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const configToDelete = dbGetAgentConfig(body.id);
  if (!configToDelete) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(configToDelete.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  if (!dbDeleteAgentConfig(body.id)) {
    return sendError(res, 404, "Agent config not found");
  }
  broadcast({ type: "agent_config_delete", id: body.id, timestamp: Date.now() });
  console.log(`[agent-config-delete] ${body.id}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentStart: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  try {
    await launchAgent(config);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

const publicRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/users": { method: "GET", handler: handleUsers },
  "/channels": { method: "GET", handler: handleListChannels },
};

const joinRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/register": { method: "POST", handler: handleRegister },
};

const adminRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/kick": { method: "POST", handler: handleKick },
  "/kick-all": { method: "POST", handler: handleKickAll },
  "/admin-send": { method: "POST", handler: handleAdminSend },
  "/admin-channel-create": { method: "POST", handler: handleAdminChannelCreate },
  "/admin-channel-delete": { method: "POST", handler: handleAdminChannelDelete },
  "/admin-channel-history": { method: "GET", handler: handleAdminChannelHistory },
  "/admin-mark-read": { method: "POST", handler: handleAdminMarkRead },
  "/admin-unread-counts": { method: "GET", handler: handleAdminUnreadCounts },
  "/admin-agent-configs": { method: "GET", handler: handleAdminAgentConfigs },
  "/admin-agent-config-create": { method: "POST", handler: handleAdminAgentConfigCreate },
  "/admin-agent-config-update": { method: "POST", handler: handleAdminAgentConfigUpdate },
  "/admin-agent-config-delete": { method: "POST", handler: handleAdminAgentConfigDelete },
  "/admin-agent-start": { method: "POST", handler: handleAdminAgentStart },
};

const protectedRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/send": { method: "POST", handler: handleSend },
  "/poll": { method: "GET", handler: handlePoll },
  "/inbox": { method: "GET", handler: handleInbox },
  "/unregister": { method: "POST", handler: handleUnregister },
  "/channel-create": { method: "POST", handler: handleChannelCreate },
  "/channel-join": { method: "POST", handler: handleChannelJoin },
  "/channel-leave": { method: "POST", handler: handleChannelLeave },
  "/channel-invite": { method: "POST", handler: handleChannelInvite },
  "/channel-history": { method: "GET", handler: handleChannelHistory },
};

function authenticateBearer(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token === expected;
}

const DEFAULT_STALE_GRACE_MS = 30_000; // 30 seconds before auto-unregister
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long a poll-disconnected agent keeps its registration before the hub
 * auto-unregisters it (invalidating its token). Configurable via
 * WALKIE_TALKIE_STALE_GRACE_MS (milliseconds); defaults to 30s to preserve
 * the existing behavior. A value <= 0 DISABLES auto-unregister entirely. The
 * agent is marked offline but keeps its registration/token until an explicit
 * unregister/kick.
 *
 * Why configurable: the default 30s is far shorter than a laptop sleep. When the
 * hub runs on a laptop that sleeps overnight, every agent's poll connection drops
 * and 30s later its token is auto-unregistered, so on wake the saved token is
 * dead (401) and the agent can't resume without re-registering. Sleep-prone hosts
 * should set this high (e.g. 86400000 = 24h) or 0 to disable, so a token survives
 * the outage and the agent resumes on the same token. Invalid values fall back to
 * the default.
 */
export function resolveStaleGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALKIE_TALKIE_STALE_GRACE_MS;
  if (raw === undefined || raw === "") return DEFAULT_STALE_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_STALE_GRACE_MS;
}

export function createHubServer(port: number, adminToken: string, joinToken: string): import("node:http").Server {
  const staleGraceMs = resolveStaleGraceMs();

  // When a poll connection drops unexpectedly, mark user offline and start grace timer
  onPollDisconnect((userName) => {
    if (!isUserRegistered(userName)) return;
    setOffline(userName);
    broadcast({ type: "status", name: userName, online: false, timestamp: Date.now() });

    // Grace <= 0 disables auto-unregister: stay registered (token survives) while
    // offline, until an explicit unregister/kick. This is what lets an agent ride
    // out a long laptop sleep and resume on the same token.
    if (staleGraceMs <= 0) {
      console.log(`[offline] ${userName} (auto-unregister disabled)`);
      return;
    }
    console.log(`[offline] ${userName} (grace period ${staleGraceMs / 1000}s)`);

    // Clear any existing grace timer
    const existing = staleTimers.get(userName);
    if (existing) clearTimeout(existing);

    staleTimers.set(
      userName,
      setTimeout(() => {
        staleTimers.delete(userName);
        if (isUserRegistered(userName) && !isOnline(userName)) {
          const role = getUserRole(userName);
          removePoll(userName);
          removeQueue(userName);
          setOffline(userName);
          unregisterUser(userName);
          broadcast({ type: "leave", name: userName, timestamp: Date.now() });
          if (role === "agent") {
            notifyBridges(`USER_LEFT: ${userName}`);
          }
          console.log(`[auto-unregister] ${userName} (stale)`);
        }
      }, staleGraceMs),
    );
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Dashboard & SSE
    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHTML(adminToken));
      return;
    }
    if (path === "/events" && req.method === "GET") {
      addSSEClient(res);
      return;
    }

    // Public routes
    const publicRoute = publicRoutes[path];
    if (publicRoute) {
      if (req.method !== publicRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      publicRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // Join routes (require join token)
    const joinRoute = joinRoutes[path];
    if (joinRoute) {
      if (req.method !== joinRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, joinToken)) {
        sendError(res, 401, "Join token required");
        return;
      }
      joinRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // Admin routes (require admin token)
    const adminRoute = adminRoutes[path];
    if (adminRoute) {
      if (req.method !== adminRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, adminToken)) {
        sendError(res, 401, "Admin token required");
        return;
      }
      adminRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // User-protected routes (require user token)
    const protectedRoute = protectedRoutes[path];
    if (protectedRoute) {
      if (req.method !== protectedRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      const userName = authenticateRequest(req);
      if (!userName) {
        sendError(res, 401, "Unauthorized");
        return;
      }
      // Any authenticated request proves the agent is alive
      if (!isOnline(userName)) {
        setOnline(userName);
        broadcast({ type: "status", name: userName, online: true, timestamp: Date.now() });
      }
      protectedRoute.handler(req, res, userName).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    sendError(res, 404, "Not found");
  }

  const server = createServer(handleRequest);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${port} is already in use. Is another Hub instance running?`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Walkie-Talkie Hub listening on http://localhost:${port}`);
  });
  return server;
}

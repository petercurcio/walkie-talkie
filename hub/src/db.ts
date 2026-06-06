import path from "node:path";
import Database from "better-sqlite3";

import type { Message, MessageImage } from "./types.js";

export interface AgentConfigRow {
  id: string;
  name: string;
  work_dir: string;
  command: string;
  auto_start: number;
  env_vars: string | null;
  created_at: number;
}

export interface ChannelRow {
  name: string;
  created_by: string;
  created_at: number;
}

let db: Database.Database;

export function initDB(): void {
  const dbPath = process.env.WALKIE_TALKIE_DB_PATH ?? path.join(process.cwd(), "walkie-talkie.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel TEXT NOT NULL,
      user_name TEXT NOT NULL,
      PRIMARY KEY (channel, user_name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      content TEXT NOT NULL,
      channel TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp
    ON messages (channel, timestamp)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS read_cursors (
      user_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_name, channel)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      work_dir TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      auto_start INTEGER NOT NULL DEFAULT 0,
      env_vars TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  try {
    db.exec("ALTER TABLE agent_configs ADD COLUMN env_vars TEXT");
  } catch {
    /* column already exists */
  }

  try {
    db.exec("ALTER TABLE messages ADD COLUMN image TEXT");
  } catch {
    /* column already exists */
  }

  // Delivery log for at-least-once delivery (delivery-ack). One row per (recipient, message)
  // recorded at route time — the exact routing output, so serving doesn't re-derive routing.
  // `id` (autoincrement) is the strictly-monotonic per-recipient cursor a client acks against.
  // Phase 1 only writes + reads this; /poll still uses the in-memory queue (no behavior change).
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_id
    ON deliveries (recipient, id)
  `);

  // Seed #all if it doesn't exist
  const existing = db.prepare("SELECT name FROM channels WHERE name = ?").get("#all");
  if (!existing) {
    db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(
      "#all",
      "system",
      Date.now(),
    );
  }
}

export function dbCreateChannel(name: string, createdBy: string): ChannelRow {
  const now = Date.now();
  db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(name, createdBy, now);
  return { name, created_by: createdBy, created_at: now };
}

export function dbDeleteChannel(name: string): boolean {
  const result = db.prepare("DELETE FROM channels WHERE name = ?").run(name);
  return result.changes > 0;
}

export function dbListChannels(): ChannelRow[] {
  return db.prepare("SELECT name, created_by, created_at FROM channels ORDER BY created_at").all() as ChannelRow[];
}

export function dbGetChannel(name: string): ChannelRow | undefined {
  return db.prepare("SELECT name, created_by, created_at FROM channels WHERE name = ?").get(name) as
    | ChannelRow
    | undefined;
}

export function dbAddChannelMember(channel: string, userName: string): void {
  db.prepare("INSERT OR IGNORE INTO channel_members (channel, user_name) VALUES (?, ?)").run(channel, userName);
}

export function dbRemoveChannelMember(channel: string, userName: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ? AND user_name = ?").run(channel, userName);
}

export function dbRemoveAllMembersOfChannel(channel: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ?").run(channel);
}

export function dbGetUserChannels(userName: string): string[] {
  const rows = db.prepare("SELECT channel FROM channel_members WHERE user_name = ?").all(userName) as {
    channel: string;
  }[];
  return rows.map((r) => r.channel);
}

const ALL_CHANNEL_MAX = 200;

export function dbSaveMessage(msg: Message): void {
  db.prepare(
    `INSERT INTO messages (id, "from", "to", content, channel, timestamp, image) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.from,
    msg.to,
    msg.content,
    msg.channel,
    msg.timestamp,
    msg.image ? JSON.stringify(msg.image) : null,
  );

  if (msg.channel === "#all") {
    dbPruneAllChannel();
  }
}

function parseMessageRow(row: Record<string, unknown>): Message {
  const imageStr = row.image as string | null;
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    content: row.content as string,
    channel: row.channel as string,
    timestamp: row.timestamp as number,
    image: imageStr ? (JSON.parse(imageStr) as MessageImage) : undefined,
  };
}

/** Record that `message` was routed to `recipient` (the delivery-ack log). */
export function dbRecordDelivery(recipient: string, messageId: string): void {
  db.prepare("INSERT INTO deliveries (recipient, message_id, created_at) VALUES (?, ?, ?)").run(
    recipient,
    messageId,
    Date.now(),
  );
}

/**
 * Messages routed to `recipient` with a delivery id greater than `cursor`, in delivery order,
 * joined to the message content. Returns the new cursor (the highest delivery id served, or
 * the input cursor if none) for the client to ack against. The basis of at-least-once: a
 * client re-asks with its last cursor and gets anything it hasn't confirmed.
 */
export function dbGetDeliveriesAfter(
  recipient: string,
  cursor: number,
  limit = 200,
): { messages: Message[]; cursor: number } {
  const rows = db
    .prepare(
      `SELECT d.id AS delivery_id, m.id AS id, m."from" AS "from", m."to" AS "to",
              m.content AS content, m.channel AS channel, m.timestamp AS timestamp, m.image AS image
       FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.recipient = ? AND d.id > ?
       ORDER BY d.id ASC LIMIT ?`,
    )
    .all(recipient, cursor, limit) as Record<string, unknown>[];
  const messages = rows.map(parseMessageRow);
  const newCursor = rows.length > 0 ? (rows[rows.length - 1].delivery_id as number) : cursor;
  return { messages, cursor: newCursor };
}

/**
 * The current highest delivery id for `recipient` (0 if none). The "now" mark a client with
 * no persisted cursor (first run, or cursor file wiped) adopts via cursor=init, so it starts
 * receiving from this point forward instead of replaying the whole delivery history.
 */
export function dbGetDeliveryHighWater(recipient: string): number {
  const row = db.prepare("SELECT MAX(id) AS hw FROM deliveries WHERE recipient = ?").get(recipient) as {
    hw: number | null;
  };
  return row.hw ?? 0;
}

export function dbGetChannelMessages(channel: string, limit = 50): Message[] {
  const rows = db
    .prepare(
      `SELECT id, "from", "to", content, channel, timestamp, image FROM messages WHERE channel = ? ORDER BY timestamp ASC LIMIT ?`,
    )
    .all(channel, limit) as Record<string, unknown>[];
  return rows.map(parseMessageRow);
}

export function dbGetRecentMessages(limit = 200): Message[] {
  const rows = db
    .prepare(`SELECT id, "from", "to", content, channel, timestamp, image FROM messages ORDER BY timestamp ASC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(parseMessageRow);
}

export function dbDeleteChannelMessages(channel: string): void {
  db.prepare("DELETE FROM messages WHERE channel = ?").run(channel);
}

export function dbUpdateReadCursor(userName: string, channel: string, timestamp?: number): void {
  const ts = timestamp ?? Date.now();
  db.prepare(
    `INSERT INTO read_cursors (user_name, channel, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_name, channel) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
  ).run(userName, channel, ts);
}

export function dbGetUnreadCounts(userName: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT m.channel, COUNT(*) as cnt
     FROM messages m
     LEFT JOIN read_cursors rc ON rc.user_name = ? AND rc.channel = m.channel
     WHERE m.timestamp > COALESCE(rc.last_read_at, 0)
     GROUP BY m.channel`,
    )
    .all(userName) as { channel: string; cnt: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.channel] = row.cnt;
  }
  return result;
}

export function dbDeleteReadCursorsForChannel(channel: string): void {
  db.prepare("DELETE FROM read_cursors WHERE channel = ?").run(channel);
}

// Agent config CRUD
export function dbCreateAgentConfig(
  id: string,
  name: string,
  workDir: string,
  command: string,
  autoStart: boolean,
  envVars?: Record<string, string>,
): AgentConfigRow {
  const now = Date.now();
  const envJson = envVars ? JSON.stringify(envVars) : null;
  db.prepare(
    "INSERT INTO agent_configs (id, name, work_dir, command, auto_start, env_vars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, name, workDir, command, autoStart ? 1 : 0, envJson, now);
  return { id, name, work_dir: workDir, command, auto_start: autoStart ? 1 : 0, env_vars: envJson, created_at: now };
}

export function dbListAgentConfigs(): AgentConfigRow[] {
  return db.prepare("SELECT * FROM agent_configs ORDER BY created_at").all() as AgentConfigRow[];
}

export function dbGetAgentConfig(id: string): AgentConfigRow | undefined {
  return db.prepare("SELECT * FROM agent_configs WHERE id = ?").get(id) as AgentConfigRow | undefined;
}

export function dbUpdateAgentConfig(
  id: string,
  updates: {
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  },
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.workDir !== undefined) {
    fields.push("work_dir = ?");
    values.push(updates.workDir);
  }
  if (updates.command !== undefined) {
    fields.push("command = ?");
    values.push(updates.command);
  }
  if (updates.autoStart !== undefined) {
    fields.push("auto_start = ?");
    values.push(updates.autoStart ? 1 : 0);
  }
  if (updates.envVars !== undefined) {
    fields.push("env_vars = ?");
    values.push(updates.envVars ? JSON.stringify(updates.envVars) : null);
  }
  if (fields.length === 0) return false;
  values.push(id);
  const result = db.prepare(`UPDATE agent_configs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function dbDeleteAgentConfig(id: string): boolean {
  const result = db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  return result.changes > 0;
}

function dbPruneAllChannel(): void {
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel = '#all'").get() as { cnt: number })
    .cnt;
  if (count > ALL_CHANNEL_MAX) {
    db.prepare(
      `DELETE FROM messages WHERE channel = '#all' AND id NOT IN (
        SELECT id FROM messages WHERE channel = '#all' ORDER BY timestamp DESC LIMIT ?
      )`,
    ).run(ALL_CHANNEL_MAX);
  }
}

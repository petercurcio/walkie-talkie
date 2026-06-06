import { randomUUID } from "node:crypto";
import { getUserRole, getUsersByRole, isUserRegistered } from "./auth.js";
import { getChannelMembers, isChannelMember } from "./channels.js";
import { dbRecordDelivery, dbSaveMessage } from "./db.js";
import { deliverMessage } from "./polling.js";
import type { Message, MessageImage } from "./types.js";

const messageQueues = new Map<string, Message[]>();

export function ensureQueue(name: string): void {
  if (!messageQueues.has(name)) {
    messageQueues.set(name, []);
  }
}

export function removeQueue(name: string): void {
  messageQueues.delete(name);
}

export function drainQueue(name: string): Message[] {
  const queue = messageQueues.get(name);
  if (!queue || queue.length === 0) return [];
  const messages = [...queue];
  queue.length = 0;
  return messages;
}

export function routeMessage(
  from: string,
  to: string,
  content: string,
  channel = "#all",
  image?: MessageImage,
): Message {
  const members = getChannelMembers(channel);

  if (to === "@all") {
    const message: Message = {
      id: randomUUID(),
      from,
      to: "@all",
      content,
      channel,
      timestamp: Date.now(),
      image,
    };

    dbSaveMessage(message);

    const senderRole = getUserRole(from);

    // Deliver to all channel members except sender.
    // When a bridge sends @all, skip other bridges to avoid relay loops.
    for (const user of members) {
      if (user === from) continue;
      if (senderRole === "bridge" && getUserRole(user) === "bridge") continue;
      enqueueAndDeliver(user, message);
    }
    return message;
  }

  const targetName = to.startsWith("@") ? to.slice(1) : to;

  if (!isUserRegistered(targetName)) {
    throw new Error(`User "${targetName}" is not connected`);
  }

  if (!isChannelMember(channel, targetName)) {
    throw new Error(`User "${targetName}" is not a member of ${channel}`);
  }

  const message: Message = {
    id: randomUUID(),
    from,
    to: targetName,
    content,
    channel,
    timestamp: Date.now(),
    image,
  };

  dbSaveMessage(message);

  // Deliver to all channel members except sender
  for (const user of members) {
    if (user !== from) {
      enqueueAndDeliver(user, message);
    }
  }
  return message;
}

export function enqueueAndDeliver(targetName: string, message: Message): void {
  // Record the delivery (at-least-once log) at the single routing chokepoint, so the log is
  // exactly the routing output. Phase 1: log only — the in-memory queue below still drives
  // /poll, so behavior is unchanged until the serve-by-cursor path lands.
  dbRecordDelivery(targetName, message.id);
  ensureQueue(targetName);
  const queue = messageQueues.get(targetName)!;
  queue.push(message);
  deliverMessage(targetName);
}

export function notifyBridges(content: string): void {
  const bridges = getUsersByRole("bridge");
  const message: Message = {
    id: randomUUID(),
    from: "system",
    to: "@bridges",
    content,
    channel: "#all",
    timestamp: Date.now(),
  };
  for (const bridge of bridges) {
    enqueueAndDeliver(bridge, message);
  }
}

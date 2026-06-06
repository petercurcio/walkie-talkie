import type { IncomingMessage, ServerResponse } from "node:http";

export interface MessageImage {
  data: string; // base64 (no data-URI prefix)
  mimeType: string; // e.g. "image/png"
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  channel: string;
  timestamp: number;
  image?: MessageImage;
}

export type UserRole = "agent" | "bridge";

export interface User {
  name: string;
  token: string;
  role: UserRole;
  registeredAt: number;
}

export interface RegisterRequest {
  name: string;
  oldToken?: string;
  role?: UserRole;
}

export interface RegisterResponse {
  token: string;
  name: string;
}

export interface SendRequest {
  to: string;
  content: string;
  channel?: string;
  image?: MessageImage;
}

export interface Channel {
  name: string;
  createdBy: string;
  createdAt: number;
}

export interface SendResponse {
  id: string;
  to: string;
}

export interface PollResponse {
  messages: Message[];
}

export interface UsersResponse {
  users: Array<{ name: string; online: boolean; role: string }>;
}

export interface ErrorResponse {
  error: string;
}

export type PendingPoll = {
  userName: string;
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Delivery cursor for serve-by-cursor (at-least-once) polls. When set, the poll is
   * resolved from the persisted delivery log (deliveries after this id), NOT by draining
   * the in-memory queue. Undefined = a legacy drain poll (at-most-once, backward compat).
   */
  cursor?: number;
};

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, userName?: string) => Promise<void>;

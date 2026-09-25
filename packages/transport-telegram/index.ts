import type {
  CoordinationMessage,
  CoordinationRoom,
  CoordinationTransport,
  TaskEnvelope,
  WorkOrderCodec,
  WorkerProtocolReply
} from "../protocol/src/index.js";

/** Telegram-specific compatibility shape for a forum topic. */
export interface TaskRoom {
  channel_id: string;
  topic_id: string;
}

/** Telegram-specific compatibility shape for an inbound forum message. */
export interface TransportMessage {
  message_id: string;
  channel_id: string;
  topic_id?: string;
  sender_id: string;
  text: string;
}

export interface SenderPolicy {
  coordinator_ids: readonly string[];
  admin_ids?: readonly string[];
}

/** Legacy Telegram-specific transport contract. Prefer CoordinationTransport for new integrations. */
export interface TransportAdapter {
  createTaskRoom(title: string): Promise<TaskRoom>;
  send(room: TaskRoom | CoordinationRoom, text: string): Promise<{ message_id: string }>;
  closeTaskRoom(room: TaskRoom): Promise<void>;
}

export function isCoordinatorSender(senderId: string, policy: SenderPolicy): boolean {
  return policy.coordinator_ids.includes(senderId);
}

export function isAdministrativeSender(senderId: string, policy: SenderPolicy): boolean {
  return isCoordinatorSender(senderId, policy) || (policy.admin_ids?.includes(senderId) ?? false);
}

export function topicConversationId(accountId: string, channelKey: string, topicId: string): string {
  if (!accountId || !channelKey || !/^\d+$/.test(topicId)) {
    throw new Error("invalid topic conversation identity");
  }
  return `${accountId}/${channelKey}#${topicId}`;
}

export function taskTopicTitle(title: string, taskId: string, maxLength = 120): string {
  if (!taskId.trim()) throw new Error("taskId is required");
  const suffix = ` [${taskId.trim()}]`;
  const available = Math.max(1, maxLength - suffix.length);
  const normalized = title.replace(/\s+/g, " ").trim() || "Task";
  return `${normalized.slice(0, available).trimEnd()}${suffix}`.slice(0, maxLength);
}

export interface DispatchArtifact {
  path: string;
  sha256: string;
}

export interface TelegramTaskDispatch {
  task_id: string;
  execution_id: string;
  title: string;
  brief: string;
  acceptance: readonly string[];
  inputs?: readonly DispatchArtifact[];
}

export interface ParsedWorkerReply extends WorkerProtocolReply {}

function normalizeBotUsername(username: string): string {
  const value = username.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,64}$/.test(value)) throw new Error("invalid bot username");
  return value;
}

export function renderTaskDispatch(
  task: TelegramTaskDispatch,
  workerBotUsername: string,
  coordinatorBotUsername: string
): string {
  const worker = normalizeBotUsername(workerBotUsername);
  const coordinator = normalizeBotUsername(coordinatorBotUsername);
  const acceptance = task.acceptance.length > 0 ? task.acceptance.map((item) => `- ${item}`).join("\n") : "- Complete the requested work.";
  const inputs = task.inputs?.length
    ? task.inputs.map((item) => `- ${item.path} (sha256: ${item.sha256})`).join("\n")
    : "(none)";
  return [
    `/task@${worker}`,
    `task: ${task.task_id}`,
    `execution: ${task.execution_id}`,
    `title: ${task.title}`,
    "",
    task.brief,
    "",
    "acceptance criteria:",
    acceptance,
    "",
    "Verified input files:",
    inputs,
    "",
    `Reply in this topic: @${coordinator} deliver ${task.task_id} <summary>`,
    `Include execution: ${task.execution_id} in every deliver/blocked/failed reply.`
  ].join("\n");
}

export function parseWorkerReply(text: string, coordinatorBotUsername?: string): ParsedWorkerReply | undefined {
  const trimmed = text.trim();
  const coordinator = coordinatorBotUsername ? normalizeBotUsername(coordinatorBotUsername) : undefined;
  const botPattern = coordinator ?? "[A-Za-z0-9_]{3,64}";
  const pattern = new RegExp(
    `(?:/(deliver|blocked|failed)@${botPattern}|@${botPattern}\\s+(deliver|blocked|failed))\\s+(\\S+)`,
    "i"
  );
  const match = pattern.exec(trimmed);
  if (!match) return undefined;
  const kind = (match[1] ?? match[2])?.toLowerCase() as ParsedWorkerReply["kind"] | undefined;
  const taskId = match[3];
  if (!kind || !taskId || taskId.startsWith("<")) return undefined;
  const executionMatch = trimmed.match(/(?:^|\n|\s)execution\s*:\s*([A-Za-z0-9._:-]+)/i);
  const execution = executionMatch?.[1];
  if (!execution) return undefined;
  const before = trimmed.slice(0, match.index).trim();
  const after = trimmed.slice(match.index + match[0].length).trim();
  const rawSummary = [before, after]
    .filter(Boolean)
    .join(" ")
    .replace(/(?:^|\s)execution\s*:\s*[A-Za-z0-9._:-]+/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    kind,
    task_id: taskId,
    execution_id: execution,
    summary: rawSummary
  };
}

export class TelegramWorkOrderCodec implements WorkOrderCodec {
  readonly #workerBotUsername: string;
  readonly #coordinatorBotUsername: string;
  readonly #maxTitleLength: number;

  constructor(workerBotUsername: string, coordinatorBotUsername: string, maxTitleLength = 120) {
    this.#workerBotUsername = normalizeBotUsername(workerBotUsername);
    this.#coordinatorBotUsername = normalizeBotUsername(coordinatorBotUsername);
    if (!Number.isInteger(maxTitleLength) || maxTitleLength < 16 || maxTitleLength > 128) {
      throw new Error("maxTitleLength must be an integer between 16 and 128");
    }
    this.#maxTitleLength = maxTitleLength;
  }

  roomTitle(task: TaskEnvelope): string {
    return taskTopicTitle(task.title, task.task_id, this.#maxTitleLength);
  }

  renderTask(task: TaskEnvelope): string {
    return renderTaskDispatch(task, this.#workerBotUsername, this.#coordinatorBotUsername);
  }

  parseWorkerReply(text: string): ParsedWorkerReply | undefined {
    return parseWorkerReply(text, this.#coordinatorBotUsername);
  }
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type TelegramFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<MinimalFetchResponse>;

function topicIdFromRoom(room: TaskRoom | CoordinationRoom): string {
  const topicId = "topic_id" in room ? room.topic_id : room.room_id;
  if (!/^\d+$/.test(topicId)) throw new Error("Telegram room_id/topic_id must be numeric");
  return topicId;
}

export function toCoordinationMessage(message: TransportMessage): CoordinationMessage {
  return {
    message_id: message.message_id,
    channel_id: message.channel_id,
    room_id: message.topic_id,
    sender_id: message.sender_id,
    text: message.text
  };
}

export class TelegramForumTransport implements CoordinationTransport, TransportAdapter {
  readonly #token: string;
  readonly #chatId: string;
  readonly #fetch: TelegramFetch;

  constructor(token: string, chatId: string, fetchImpl: TelegramFetch = globalThis.fetch as unknown as TelegramFetch) {
    if (!token.trim()) throw new Error("Telegram bot token is required");
    if (!chatId.trim()) throw new Error("Telegram chat id is required");
    if (!fetchImpl) throw new Error("fetch implementation is required");
    this.#token = token;
    this.#chatId = chatId;
    this.#fetch = fetchImpl;
  }

  async #call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const decoded = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !decoded.ok || decoded.result === undefined) {
      const retry = decoded.parameters?.retry_after;
      const suffix = retry ? `; retry_after=${retry}` : "";
      throw new Error(`Telegram ${method} failed (${response.status}): ${decoded.description ?? "unknown error"}${suffix}`);
    }
    return decoded.result;
  }

  async createRoom(title: string): Promise<CoordinationRoom> {
    const room = await this.createTaskRoom(title);
    return { channel_id: room.channel_id, room_id: room.topic_id };
  }

  async createTaskRoom(title: string): Promise<TaskRoom> {
    const result = await this.#call<{ message_thread_id: number }>("createForumTopic", {
      chat_id: this.#chatId,
      name: title
    });
    return { channel_id: this.#chatId, topic_id: String(result.message_thread_id) };
  }

  async send(room: TaskRoom | CoordinationRoom, text: string): Promise<{ message_id: string }> {
    if (room.channel_id !== this.#chatId) throw new Error("task room belongs to a different Telegram chat");
    const result = await this.#call<{ message_id: number }>("sendMessage", {
      chat_id: room.channel_id,
      message_thread_id: Number(topicIdFromRoom(room)),
      text
    });
    return { message_id: String(result.message_id) };
  }

  async closeRoom(room: CoordinationRoom): Promise<void> {
    await this.#close(room);
  }

  async closeTaskRoom(room: TaskRoom): Promise<void> {
    await this.#close(room);
  }

  async #close(room: TaskRoom | CoordinationRoom): Promise<void> {
    if (room.channel_id !== this.#chatId) throw new Error("task room belongs to a different Telegram chat");
    await this.#call<boolean>("closeForumTopic", {
      chat_id: room.channel_id,
      message_thread_id: Number(topicIdFromRoom(room))
    });
  }
}

export interface WorkerSpawnCandidate {
  sender_id: string;
  text: string;
  channel_id: string;
  topic_id?: string;
}

export function shouldColdStartWorker(
  candidate: WorkerSpawnCandidate,
  policy: SenderPolicy,
  workerBotUsername: string
): boolean {
  if (!candidate.topic_id || !isCoordinatorSender(candidate.sender_id, policy)) return false;
  const worker = normalizeBotUsername(workerBotUsername);
  return new RegExp(`@${worker}\\b`, "i").test(candidate.text);
}

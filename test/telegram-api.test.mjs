import assert from "node:assert/strict";
import test from "node:test";

import { TelegramForumTransport } from "../dist/packages/transport-telegram/index.js";

function response(result, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => result };
}

test("Telegram forum transport creates, sends to, and closes a task topic", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: url.replace(/bot[^/]+/, "bot<redacted>"), body });
    if (url.endsWith("/createForumTopic")) return response({ ok: true, result: { message_thread_id: 77 } });
    if (url.endsWith("/sendMessage")) return response({ ok: true, result: { message_id: 88 } });
    if (url.endsWith("/closeForumTopic")) return response({ ok: true, result: true });
    return response({ ok: false, description: "unexpected" }, 400);
  };
  const transport = new TelegramForumTransport("example-token", "example-chat", fakeFetch);
  const room = await transport.createTaskRoom("Example [task-1]");
  assert.deepEqual(room, { channel_id: "example-chat", topic_id: "77" });
  assert.deepEqual(await transport.send(room, "work order"), { message_id: "88" });
  await transport.closeTaskRoom(room);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.message_thread_id, 77);
});

test("Telegram API errors surface retry_after without exposing the token in the error", async () => {
  const fakeFetch = async () => response({ ok: false, description: "Too Many Requests", parameters: { retry_after: 9 } }, 429);
  const transport = new TelegramForumTransport("sensitive-example-token", "example-chat", fakeFetch);
  await assert.rejects(
    () => transport.createTaskRoom("Example"),
    (error) => error instanceof Error && /retry_after=9/.test(error.message) && !error.message.includes("sensitive-example-token")
  );
});


test("Telegram forum transport also implements the generic room contract", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/createForumTopic")) return response({ ok: true, result: { message_thread_id: 91 } });
    if (url.endsWith("/sendMessage")) return response({ ok: true, result: { message_id: 92 } });
    if (url.endsWith("/closeForumTopic")) return response({ ok: true, result: true });
    return response({ ok: false, description: "unexpected" }, 400);
  };
  const transport = new TelegramForumTransport("example-token", "example-chat", fakeFetch);
  const room = await transport.createRoom("Generic room");
  assert.deepEqual(room, { channel_id: "example-chat", room_id: "91" });
  assert.deepEqual(await transport.send(room, "work order"), { message_id: "92" });
  await transport.closeRoom(room);
  assert.equal(calls[1].body.message_thread_id, 91);
  assert.equal(calls[2].body.message_thread_id, 91);
});


test("Telegram generic transport rejects a non-numeric room id before API send", async () => {
  let called = false;
  const transport = new TelegramForumTransport("example-token", "example-chat", async () => {
    called = true;
    return response({ ok: true, result: { message_id: 1 } });
  });
  await assert.rejects(
    () => transport.send({ channel_id: "example-chat", room_id: "not-a-topic" }, "work"),
    /must be numeric/
  );
  assert.equal(called, false);
});

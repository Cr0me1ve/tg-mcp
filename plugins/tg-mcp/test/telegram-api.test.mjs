import assert from "node:assert/strict";
import test from "node:test";

import { TelegramApi, TelegramApiError } from "../src/telegram-api.mjs";

test("TelegramApi sends Bot API payloads through the injected fetch implementation", async () => {
  const requests = [];
  const api = new TelegramApi("123:top-secret", {
    apiBase: "https://telegram.example///",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 42 } }),
      };
    },
  });

  const result = await api.sendMessage("77", "A question", {
    force_reply: true,
  });

  assert.deepEqual(result, { message_id: 42 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://telegram.example/bot123:top-secret/sendMessage");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    chat_id: "77",
    text: "A question",
    force_reply: true,
  });
});

test("TelegramApi receives callback queries and can acknowledge them", async () => {
  const requests = [];
  const api = new TelegramApi("123:top-secret", {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: true }),
      };
    },
  });

  await api.getUpdates({ offset: 19, timeout: 7 });
  await api.answerCallbackQuery("callback-id");

  assert.equal(requests[0].url, "https://api.telegram.org/bot123:top-secret/getUpdates");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    offset: 19,
    timeout: 7,
    allowed_updates: ["message", "callback_query"],
  });
  assert.equal(requests[1].url, "https://api.telegram.org/bot123:top-secret/answerCallbackQuery");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    callback_query_id: "callback-id",
  });
});

test("TelegramApi reports remote and network failures without leaking the bot token", async () => {
  const token = "123:very-secret-token";
  const remoteApi = new TelegramApi(token, {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      }),
    }),
  });

  await assert.rejects(
    remoteApi.getMe(),
    (error) =>
      error instanceof TelegramApiError &&
      error.code === 401 &&
      !error.message.includes(token),
  );

  const networkApi = new TelegramApi(token, {
    fetchImpl: async () => {
      throw new Error("socket broke");
    },
  });
  await assert.rejects(
    networkApi.getMe(),
    (error) =>
      error instanceof TelegramApiError &&
      error.message.includes("network request failed") &&
      !error.message.includes(token),
  );
});

test("TelegramApi preserves abort errors for callers that cancel a request", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("stop", "AbortError"));
  const api = new TelegramApi("123:token", {
    fetchImpl: async () => {
      throw controller.signal.reason;
    },
  });

  await assert.rejects(api.getMe({ signal: controller.signal }), {
    name: "AbortError",
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StateStore } from "../src/state-store.mjs";

export async function makeStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-mcp-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new StateStore(path.join(directory, "state.json"));
}

export function makeAbortError() {
  return new DOMException("Aborted", "AbortError");
}

export class FakeTelegramApi {
  sentMessages = [];
  answeredCallbacks = [];
  deletedWebhook = false;
  getUpdatesCalls = 0;
  nextMessageId = 100;

  constructor({ bot = { id: 123, username: "test_bridge_bot", is_bot: true } } = {}) {
    this.bot = bot;
  }

  async getMe() {
    return this.bot;
  }

  async deleteWebhook() {
    this.deletedWebhook = true;
    return true;
  }

  async getUpdates({ signal } = {}) {
    this.getUpdatesCalls += 1;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(makeAbortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(makeAbortError()), {
        once: true,
      });
      // A fake long-poll intentionally waits until bridge.close() aborts it.
      void resolve;
    });
  }

  async sendMessage(chatId, text, options = {}) {
    const message = {
      chatId: String(chatId),
      text,
      options,
      message_id: this.nextMessageId++,
    };
    this.sentMessages.push(message);
    return { message_id: message.message_id };
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    this.answeredCallbacks.push({
      callbackQueryId: String(callbackQueryId),
      options,
    });
    return true;
  }
}

export async function configureStore(store, {
  token = "123456:secret-test-token",
  botId = "123",
  username = "test_bridge_bot",
  binding = {
    chatId: "77",
    userId: "88",
    displayName: "Trusted Person",
    boundAt: "2026-01-01T00:00:00.000Z",
  },
} = {}) {
  await store.update((state) => {
    state.bot = { token, id: botId, username };
    state.binding = binding;
  });
}

export function telegramUpdate({
  updateId = 1,
  chatId = 77,
  userId = 88,
  text = "answer",
  chatType = "private",
  messageId = 500,
  replyToMessageId,
} = {}) {
  const message = {
    message_id: messageId,
    chat: { id: chatId, type: chatType },
    from: { id: userId, first_name: "Trusted", last_name: "Person" },
    text,
  };
  if (replyToMessageId !== undefined) {
    message.reply_to_message = { message_id: replyToMessageId };
  }
  return { update_id: updateId, message };
}

export function telegramCallbackUpdate({
  updateId = 1,
  callbackQueryId = "callback-1",
  chatId = 77,
  userId = 88,
  data = "option",
  messageId = 500,
} = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackQueryId,
      from: { id: userId, first_name: "Trusted", last_name: "Person" },
      data,
      message: {
        message_id: messageId,
        chat: { id: chatId, type: "private" },
      },
    },
  };
}

export async function waitFor(check, { timeoutMilliseconds = 500 } = {}) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out while waiting for test condition.");
}

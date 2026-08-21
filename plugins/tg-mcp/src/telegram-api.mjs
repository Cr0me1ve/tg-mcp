const DEFAULT_API_BASE = "https://api.telegram.org";

export class TelegramApiError extends Error {
  constructor(method, code, description) {
    super(
      `Telegram ${method} failed${
        code ? ` with code ${code}` : ""
      }: ${description || "unknown error"}`,
    );
    this.name = "TelegramApiError";
    this.method = method;
    this.code = code ?? null;
  }
}

export class TelegramApi {
  #token;
  #fetch;
  #apiBase;

  constructor(token, { fetchImpl = globalThis.fetch, apiBase } = {}) {
    if (!token || typeof token !== "string") {
      throw new Error("A Telegram bot token is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required.");
    }

    this.#token = token.trim();
    this.#fetch = fetchImpl;
    this.#apiBase = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  async getMe(options) {
    return this.call("getMe", {}, options);
  }

  async deleteWebhook(options) {
    return this.call(
      "deleteWebhook",
      { drop_pending_updates: false },
      options,
    );
  }

  async getUpdates({ offset, timeout = 25, signal } = {}) {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      },
      { signal },
    );
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    const { signal, ...callbackOptions } = options;
    return this.call(
      "answerCallbackQuery",
      {
        callback_query_id: callbackQueryId,
        ...callbackOptions,
      },
      { signal },
    );
  }

  async sendMessage(chatId, text, options = {}) {
    const { signal, ...messageOptions } = options;
    return this.call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...messageOptions,
      },
      { signal },
    );
  }

  async call(method, payload, { signal } = {}) {
    let response;
    try {
      response = await this.#fetch(
        `${this.#apiBase}/bot${this.#token}/${method}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal,
        },
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new TelegramApiError(method, null, "network request failed");
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new TelegramApiError(
        method,
        response.status,
        "invalid JSON response",
      );
    }

    if (!response.ok || body?.ok !== true) {
      throw new TelegramApiError(
        method,
        body?.error_code ?? response.status,
        body?.description,
      );
    }

    return body.result;
  }
}

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { TelegramApi } from "./telegram-api.mjs";

const ANSWER_EVENT = "question-answer";
const BINDING_EVENT = "binding";
const MAX_TELEGRAM_TEXT = 3900;

function isoNow() {
  return new Date().toISOString();
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function waitForEvent({
  emitter,
  event,
  predicate,
  currentValue,
  timeoutSeconds,
  signal,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", onAbort);
      emitter.off(event, onEvent);
      resolve(value);
    };
    const onEvent = (value) => {
      if (predicate(value)) {
        finish(value);
      }
    };
    const timeout =
      timeoutSeconds > 0
        ? setTimeout(() => finish(null), timeoutSeconds * 1000)
        : null;

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) clearTimeout(timeout);
      emitter.off(event, onEvent);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    emitter.on(event, onEvent);
    signal?.addEventListener("abort", onAbort, { once: true });

    void Promise.resolve()
      .then(currentValue)
      .then((value) => {
        if (value !== null && value !== undefined && predicate(value)) {
          finish(value);
        }
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        emitter.off(event, onEvent);
        reject(error);
      });
  });
}

function displayName(message) {
  const parts = [
    message?.from?.first_name,
    message?.from?.last_name,
  ].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return message?.from?.username ? `@${message.from.username}` : "Telegram user";
}

function messageText(message) {
  const text = message?.text ?? message?.caption;
  return typeof text === "string" ? text.trim() : "";
}

function questionSummary(question) {
  return {
    id: question.id,
    status: question.status,
    scope: question.scope,
    question: question.question,
    context: question.context,
    options: question.options,
    answer: question.answer,
    createdAt: question.createdAt,
    answeredAt: question.answeredAt,
  };
}

function buildTelegramQuestion(question) {
  const sections = [
    question.scope === "workstream"
      ? "⏸ Вопрос от субагента Codex"
      : "⏸ Блокирующий вопрос от Codex",
    `ID: ${question.id}`,
    "",
    question.question,
  ];

  if (question.context) {
    sections.push("", "Контекст:", question.context);
  }

  if (question.options.length > 0) {
    sections.push(
      "",
      "Варианты:",
      ...question.options.map((option, index) => `${index + 1}. ${option}`),
    );
  }

  sections.push(
    "",
    "Ответьте reply-сообщением на этот вопрос. Ответ передастся агенту как информация, но не как разрешение на опасные действия.",
  );

  const text = sections.join("\n");
  return text.length <= MAX_TELEGRAM_TEXT
    ? text
    : `${text.slice(0, MAX_TELEGRAM_TEXT - 16)}\n…[сокращено]`;
}

export class HumanBridge extends EventEmitter {
  #store;
  #apiFactory;
  #now;
  #idFactory;
  #pollTimeoutSeconds;
  #retryDelayMilliseconds;
  #api = null;
  #pollAbortController = null;
  #pollTask = null;
  #lastPollError = null;

  constructor({
    store,
    apiFactory = (token) => new TelegramApi(token),
    now = isoNow,
    idFactory = randomUUID,
    pollTimeoutSeconds = 25,
    retryDelayMilliseconds = 1000,
  }) {
    super();
    if (!store) {
      throw new Error("A state store is required.");
    }
    this.#store = store;
    this.#apiFactory = apiFactory;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#pollTimeoutSeconds = pollTimeoutSeconds;
    this.#retryDelayMilliseconds = retryDelayMilliseconds;
  }

  async initialize() {
    const state = await this.#store.read();
    if (!state.bot.token) {
      return this.status();
    }

    const api = this.#apiFactory(state.bot.token);
    this.#api = api;
    this.#startPolling(api);
    return this.status();
  }

  async connect(botToken, { waitSeconds = 300, signal } = {}) {
    const token = botToken?.trim();
    if (!token) {
      throw new Error("bot_token is required.");
    }

    const api = this.#apiFactory(token);
    const bot = await api.getMe({ signal });
    if (!bot?.id || bot?.is_bot !== true) {
      throw new Error("The supplied token does not belong to a Telegram bot.");
    }
    await api.deleteWebhook({ signal });

    await this.#stopPolling();
    const cancelledQuestions = [];
    await this.#store.update((state) => {
      const previousBotId = state.bot.id;
      const botChanged =
        previousBotId !== null && String(previousBotId) !== String(bot.id);

      state.bot = {
        token,
        id: String(bot.id),
        username: bot.username ?? null,
      };

      if (botChanged) {
        state.binding = {
          chatId: null,
          userId: null,
          displayName: null,
          boundAt: null,
        };
        for (const question of Object.values(state.questions)) {
          if (["sending", "pending"].includes(question.status)) {
            question.status = "cancelled";
            question.cancelReason = "bot_reconfigured";
            question.cancelledAt = this.#now();
            cancelledQuestions.push(structuredClone(question));
          }
        }
      }
    });
    for (const question of cancelledQuestions) {
      this.emit(ANSWER_EVENT, question);
    }

    this.#api = api;
    this.#lastPollError = null;
    this.#startPolling(api);

    let status = await this.status();
    if (!status.bound && waitSeconds > 0) {
      await this.#waitForBinding(waitSeconds, signal);
      status = await this.status();
    }
    return status;
  }

  async status() {
    const state = await this.#store.read();
    const pendingQuestions = Object.values(state.questions).filter((question) =>
      ["sending", "pending"].includes(question.status),
    );

    return {
      connected: Boolean(state.bot.token),
      polling: Boolean(this.#pollTask),
      botUsername: state.bot.username,
      bound: Boolean(state.binding.chatId),
      boundDisplayName: state.binding.displayName,
      pendingQuestionCount: pendingQuestions.length,
      pendingQuestionIds: pendingQuestions.map((question) => question.id),
      lastPollError: this.#lastPollError,
    };
  }

  async askHuman(
    {
      question,
      context = "",
      options = [],
      scope = "entire_task",
      waitSeconds = 3600,
    },
    { signal } = {},
  ) {
    const state = await this.#store.read();
    if (!state.bot.token) {
      throw new Error(
        "Telegram is not configured. Call telegram_connect with a bot token first.",
      );
    }
    if (!state.binding.chatId) {
      throw new Error(
        "Telegram is waiting for /start. Ask the user to open the bot and send /start.",
      );
    }

    if (!this.#api) {
      await this.initialize();
    }

    const id = this.#idFactory();
    const createdAt = this.#now();
    const normalizedQuestion = {
      id,
      status: "sending",
      scope,
      question: question.trim(),
      context: context.trim(),
      options: options.map((option) => option.trim()).filter(Boolean),
      telegramMessageId: null,
      answer: null,
      answeredAt: null,
      answeredByUserId: null,
      createdAt,
    };

    await this.#store.update((draft) => {
      draft.questions[id] = normalizedQuestion;
    });

    let sentMessage;
    try {
      sentMessage = await this.#api.sendMessage(
        state.binding.chatId,
        buildTelegramQuestion(normalizedQuestion),
        {
          force_reply: true,
          protect_content: true,
          signal,
        },
      );
    } catch (error) {
      await this.#store.update((draft) => {
        const stored = draft.questions[id];
        if (stored) {
          stored.status = "failed";
          stored.failedAt = this.#now();
          stored.failureReason = "telegram_send_failed";
        }
      });
      throw error;
    }

    await this.#store.update((draft) => {
      const stored = draft.questions[id];
      if (stored) {
        stored.status = "pending";
        stored.telegramMessageId = sentMessage.message_id;
      }
    });

    const result = await this.waitForAnswer(id, { waitSeconds, signal });
    return {
      ...result,
      instruction:
        result.status === "answered"
          ? "Continue the original task using this answer."
          : "The question remains pending. Do not treat the blocked work as complete.",
    };
  }

  async waitForAnswer(questionId, { waitSeconds = 3600, signal } = {}) {
    const current = await this.#getQuestion(questionId);
    if (!current) {
      throw new Error(`Unknown question_id: ${questionId}`);
    }
    if (!["sending", "pending"].includes(current.status)) {
      return questionSummary(current);
    }

    const answer = await waitForEvent({
      emitter: this,
      event: ANSWER_EVENT,
      predicate: (question) =>
        question.id === questionId &&
        !["sending", "pending"].includes(question.status),
      currentValue: () => this.#getQuestion(questionId),
      timeoutSeconds: waitSeconds,
      signal,
    });

    if (answer) {
      return questionSummary(answer);
    }

    const latest = await this.#getQuestion(questionId);
    return {
      ...questionSummary(latest),
      status: ["sending", "pending"].includes(latest.status)
        ? "waiting"
        : latest.status,
    };
  }

  async cancelQuestion(questionId) {
    let cancelled = null;
    await this.#store.update((state) => {
      const question = state.questions[questionId];
      if (!question) {
        return;
      }
      if (["sending", "pending"].includes(question.status)) {
        question.status = "cancelled";
        question.cancelReason = "cancelled_by_agent";
        question.cancelledAt = this.#now();
      }
      cancelled = structuredClone(question);
    });

    if (!cancelled) {
      throw new Error(`Unknown question_id: ${questionId}`);
    }
    this.emit(ANSWER_EVENT, cancelled);
    return questionSummary(cancelled);
  }

  async handleUpdate(update) {
    const updateId = update?.update_id;
    if (!Number.isSafeInteger(updateId)) {
      return;
    }

    try {
      const message = update.message;
      if (!message?.chat || !message?.from) {
        return;
      }

      const state = await this.#store.read();
      const chatId = String(message.chat.id);
      const userId = String(message.from.id);
      const text = messageText(message);

      if (!state.binding.chatId) {
        const isPrivateStart =
          message.chat.type === "private" &&
          /^\/start(?:@\w+)?(?:\s|$)/i.test(text);
        if (!isPrivateStart) {
          return;
        }

        let didBind = false;
        await this.#store.update((draft) => {
          if (!draft.binding.chatId) {
            draft.binding = {
              chatId,
              userId,
              displayName: displayName(message),
              boundAt: this.#now(),
            };
            didBind = true;
          }
        });

        if (didBind) {
          await this.#api?.sendMessage(
            chatId,
            "✅ Telegram подключён к Codex. Этот бот теперь принимает ответы только из данного чата.",
            { protect_content: true },
          );
          this.emit(BINDING_EVENT, {
            chatId,
            userId,
            displayName: displayName(message),
          });
        }
        return;
      }

      if (
        chatId !== String(state.binding.chatId) ||
        userId !== String(state.binding.userId)
      ) {
        return;
      }

      if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
        await this.#api?.sendMessage(
          chatId,
          "✅ Этот чат уже подключён к Codex.",
          { protect_content: true },
        );
        return;
      }

      if (!text) {
        return;
      }

      const pending = Object.values(state.questions).filter(
        (question) => question.status === "pending",
      );
      const replyMessageId = message.reply_to_message?.message_id;
      let question =
        replyMessageId === undefined
          ? null
          : pending.find(
              (candidate) =>
                String(candidate.telegramMessageId) === String(replyMessageId),
            );

      if (!question && pending.length === 1) {
        [question] = pending;
      }

      if (!question) {
        if (pending.length > 1) {
          await this.#api?.sendMessage(
            chatId,
            "Есть несколько ожидающих вопросов. Ответьте reply-сообщением на нужный вопрос.",
            { protect_content: true },
          );
        }
        return;
      }

      let answered = null;
      await this.#store.update((draft) => {
        const stored = draft.questions[question.id];
        if (!stored || stored.status !== "pending") {
          return;
        }
        stored.status = "answered";
        stored.answer = text.slice(0, 12000);
        stored.answeredAt = this.#now();
        stored.answeredByUserId = userId;
        answered = structuredClone(stored);
      });

      if (answered) {
        this.emit(ANSWER_EVENT, answered);
        await this.#api?.sendMessage(
          chatId,
          `✅ Ответ принят для вопроса ${answered.id}.`,
          {
            reply_to_message_id: message.message_id,
            protect_content: true,
          },
        );
      }
    } finally {
      await this.#store.update((state) => {
        state.lastUpdateId = Math.max(state.lastUpdateId, updateId);
      });
    }
  }

  async close() {
    await this.#stopPolling();
  }

  async #getQuestion(questionId) {
    const state = await this.#store.read();
    return state.questions[questionId]
      ? structuredClone(state.questions[questionId])
      : null;
  }

  async #waitForBinding(waitSeconds, signal) {
    const existing = await this.#store.read();
    if (existing.binding.chatId) {
      return existing.binding;
    }

    return waitForEvent({
      emitter: this,
      event: BINDING_EVENT,
      predicate: (binding) => Boolean(binding?.chatId),
      currentValue: async () => (await this.#store.read()).binding,
      timeoutSeconds: waitSeconds,
      signal,
    });
  }

  #startPolling(api) {
    if (this.#pollTask) {
      return;
    }

    this.#pollAbortController = new AbortController();
    const { signal } = this.#pollAbortController;
    this.#pollTask = this.#pollLoop(api, signal).finally(() => {
      if (this.#pollAbortController?.signal === signal) {
        this.#pollTask = null;
        this.#pollAbortController = null;
      }
    });
  }

  async #stopPolling() {
    if (!this.#pollTask) {
      return;
    }
    const task = this.#pollTask;
    this.#pollAbortController?.abort();
    await task.catch(() => undefined);
    if (this.#pollTask === task) {
      this.#pollTask = null;
      this.#pollAbortController = null;
    }
  }

  async #pollLoop(api, signal) {
    while (!signal.aborted) {
      try {
        const state = await this.#store.read();
        const updates = await api.getUpdates({
          offset: state.lastUpdateId + 1,
          timeout: this.#pollTimeoutSeconds,
          signal,
        });
        this.#lastPollError = null;
        for (const update of updates) {
          if (signal.aborted) {
            break;
          }
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") {
          return;
        }
        this.#lastPollError =
          error?.code === 401
            ? "telegram_auth_failed"
            : "telegram_poll_failed";
        await sleep(this.#retryDelayMilliseconds, signal).catch(() => undefined);
      }
    }
  }
}

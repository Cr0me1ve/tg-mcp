import assert from "node:assert/strict";
import test from "node:test";

import { HumanBridge } from "../src/human-bridge.mjs";
import { StateStore } from "../src/state-store.mjs";
import {
  configureStore,
  FakeTelegramApi,
  telegramCallbackUpdate,
  makeStore,
  telegramUpdate,
  waitFor,
} from "./helpers.mjs";

function makeBridge(store, api, { ids = ["q-1", "q-2", "q-3"], ...options } = {}) {
  return new HumanBridge({
    store,
    apiFactory: () => api,
    idFactory: () => ids.shift(),
    now: () => "2026-07-25T12:00:00.000Z",
    pollTimeoutSeconds: 1,
    retryDelayMilliseconds: 1,
    ...options,
  });
}

async function addPendingQuestion(store, {
  id,
  telegramMessageId,
  question = "Which option?",
} = {}) {
  await store.update((state) => {
    state.questions[id] = {
      id,
      status: "pending",
      scope: "entire_task",
      question,
      context: "",
      options: [],
      telegramMessageId,
      answer: null,
      answeredAt: null,
      answeredByUserId: null,
      createdAt: "2026-07-25T12:00:00.000Z",
    };
  });
}

test("first private /start binds exactly one chat and public status never exposes token", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api);
  t.after(() => bridge.close());

  const token = "123:never-show-this-token";
  const beforeBinding = await bridge.connect(token, { waitSeconds: 0 });
  assert.equal(beforeBinding.bound, false);
  assert.equal(JSON.stringify(beforeBinding).includes(token), false);

  await bridge.handleUpdate(
    telegramUpdate({ text: "/start hello", chatId: 77, userId: 88 }),
  );
  await bridge.handleUpdate(
    telegramUpdate({
      updateId: 2,
      text: "/start",
      chatId: 99,
      userId: 100,
    }),
  );

  const state = await store.read();
  assert.deepEqual(state.binding, {
    chatId: "77",
    userId: "88",
    displayName: "Trusted Person",
    boundAt: "2026-07-25T12:00:00.000Z",
  });
  assert.equal(api.sentMessages.filter((message) => message.text.startsWith("✅ Telegram подключён")).length, 1);
  const status = await bridge.status();
  assert.equal(status.bound, true);
  assert.equal(JSON.stringify(status).includes(token), false);
});

test("non-private starts and messages from a different chat or user cannot bind or answer", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api);
  t.after(() => bridge.close());

  await configureStore(store, { binding: { chatId: "77", userId: "88", displayName: "Trusted", boundAt: "old" } });
  await addPendingQuestion(store, { id: "q-1", telegramMessageId: 201 });
  await bridge.initialize();

  await bridge.handleUpdate(telegramUpdate({ chatId: 77, userId: 999, text: "intruder" }));
  await bridge.handleUpdate(telegramUpdate({ updateId: 2, chatId: 999, userId: 88, text: "other chat" }));

  const state = await store.read();
  assert.equal(state.questions["q-1"].status, "pending");
  assert.equal(state.questions["q-1"].answer, null);

  const unboundStore = await makeStore(t);
  const unboundBridge = makeBridge(unboundStore, new FakeTelegramApi());
  t.after(() => unboundBridge.close());
  await configureStore(unboundStore, { binding: { chatId: null, userId: null, displayName: null, boundAt: null } });
  await unboundBridge.initialize();
  await unboundBridge.handleUpdate(telegramUpdate({ text: "/start", chatType: "group" }));
  assert.equal((await unboundStore.read()).binding.chatId, null);
});

test("a reply is correlated to its Telegram question while other pending questions remain", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api);
  t.after(() => bridge.close());
  await configureStore(store);
  await addPendingQuestion(store, { id: "first", telegramMessageId: 201 });
  await addPendingQuestion(store, { id: "second", telegramMessageId: 202 });
  await bridge.initialize();

  await bridge.handleUpdate(
    telegramUpdate({ text: "Answer for the second", replyToMessageId: 202 }),
  );

  const state = await store.read();
  assert.equal(state.questions.first.status, "pending");
  assert.equal(state.questions.second.status, "answered");
  assert.equal(state.questions.second.answer, "Answer for the second");
  assert.equal(state.questions.second.answeredByUserId, "88");
});

test("suggested options use inline buttons and a callback answers its own question", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api, { ids: ["first", "second"] });
  t.after(() => bridge.close());
  await configureStore(store);
  await bridge.initialize();

  await bridge.askHuman({
    question: "First choice?",
    options: ["Keep", "Discard"],
    waitSeconds: 0,
  });
  await bridge.askHuman({
    question: "Second choice?",
    options: ["Left", "Right"],
    waitSeconds: 0,
  });

  const [firstMessage, secondMessage] = api.sentMessages.filter((message) =>
    message.text.includes("choice?"),
  );
  const firstKeyboard = firstMessage.options.reply_markup.inline_keyboard;
  const secondKeyboard = secondMessage.options.reply_markup.inline_keyboard;
  assert.deepEqual(firstKeyboard.flat().map((button) => button.text), ["Keep", "Discard"]);
  assert.deepEqual(secondKeyboard.flat().map((button) => button.text), ["Left", "Right"]);
  assert.ok(firstKeyboard.flat().every((button) => typeof button.callback_data === "string"));
  assert.equal(firstKeyboard.flat()[1].callback_data, "q:first:1");

  await bridge.handleUpdate(
    telegramCallbackUpdate({
      data: firstKeyboard.flat()[1].callback_data,
      messageId: firstMessage.message_id,
    }),
  );

  const state = await store.read();
  assert.equal(state.questions.first.status, "answered");
  assert.equal(state.questions.first.answer, "Discard");
  assert.equal(state.questions.second.status, "pending");
  assert.deepEqual(api.answeredCallbacks, [{
    callbackQueryId: "callback-1",
    options: { text: "✅ Ответ принят." },
  }]);
});

test("the sole pending question with options still accepts a custom text answer", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api, { ids: ["custom-answer"] });
  t.after(() => bridge.close());
  await configureStore(store);
  await bridge.initialize();

  await bridge.askHuman({
    question: "Choose or explain",
    options: ["Option A", "Option B"],
    waitSeconds: 0,
  });
  await bridge.handleUpdate(
    telegramUpdate({ text: "Neither option: use a custom approach." }),
  );

  const state = await store.read();
  assert.equal(state.questions["custom-answer"].status, "answered");
  assert.equal(
    state.questions["custom-answer"].answer,
    "Neither option: use a custom approach.",
  );
});

test("invalid, oversized, and unauthorized callbacks leave pending questions untouched", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api, { ids: ["question"] });
  t.after(() => bridge.close());
  await configureStore(store);
  await bridge.initialize();

  await bridge.askHuman({
    question: "Choose safely",
    options: ["Safe", "Unsafe"],
    waitSeconds: 0,
  });
  const sent = api.sentMessages.find((message) => message.text.includes("Choose safely"));
  const validCallback = sent.options.reply_markup.inline_keyboard[0][0].callback_data;

  await bridge.handleUpdate(
    telegramCallbackUpdate({ updateId: 2, callbackQueryId: "invalid", data: "not-a-question" }),
  );
  await bridge.handleUpdate(
    telegramCallbackUpdate({ updateId: 3, callbackQueryId: "oversized", data: "x".repeat(257) }),
  );
  await bridge.handleUpdate(
    telegramCallbackUpdate({
      updateId: 4,
      callbackQueryId: "intruder",
      userId: 999,
      data: validCallback,
      messageId: sent.message_id,
    }),
  );

  const state = await store.read();
  assert.equal(state.questions.question.status, "pending");
  assert.equal(state.questions.question.answer, null);
  assert.deepEqual(api.answeredCallbacks, [
    {
      callbackQueryId: "invalid",
      options: { text: "Этот вопрос уже закрыт." },
    },
    {
      callbackQueryId: "oversized",
      options: { text: "Этот вопрос уже закрыт." },
    },
  ]);
});

test("plain reply answers the only pending question but requires a reply when there are several", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api);
  t.after(() => bridge.close());
  await configureStore(store);
  await addPendingQuestion(store, { id: "only", telegramMessageId: 201 });
  await bridge.initialize();

  await bridge.handleUpdate(telegramUpdate({ text: "plain answer" }));
  assert.equal((await store.read()).questions.only.answer, "plain answer");

  await addPendingQuestion(store, { id: "a", telegramMessageId: 202 });
  await addPendingQuestion(store, { id: "b", telegramMessageId: 203 });
  await bridge.handleUpdate(telegramUpdate({ updateId: 2, text: "ambiguous plain answer" }));
  const state = await store.read();
  assert.equal(state.questions.a.status, "pending");
  assert.equal(state.questions.b.status, "pending");
  assert.equal(api.sentMessages.some((message) => message.text.includes("несколько ожидающих вопросов")), false);
});

test("binding sends correlation guidance once; repeat starts and ambiguous text do not repeat it", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api);
  t.after(() => bridge.close());
  await configureStore(store, {
    binding: { chatId: null, userId: null, displayName: null, boundAt: null },
  });
  await bridge.initialize();

  await bridge.handleUpdate(telegramUpdate({ text: "/start", messageId: 10 }));
  const bindingNotice = api.sentMessages.at(-1);
  assert.match(bindingNotice.text, /репла/i);
  assert.match(bindingNotice.text, /опасн/i);

  await bridge.handleUpdate(telegramUpdate({ updateId: 2, text: "/start", messageId: 11 }));
  const repeatStart = api.sentMessages.at(-1);
  assert.match(repeatStart.text, /уже подключ/i);
  assert.equal(repeatStart.text.includes("репла"), false);

  await addPendingQuestion(store, { id: "one", telegramMessageId: 201 });
  await addPendingQuestion(store, { id: "two", telegramMessageId: 202 });
  const sentBeforeAmbiguousText = api.sentMessages.length;
  await bridge.handleUpdate(telegramUpdate({ updateId: 3, text: "Which one?", messageId: 12 }));

  assert.equal(api.sentMessages.length, sentBeforeAmbiguousText);
});

test("a waiter observes a terminal answer written through another StateStore without a local event", async (t) => {
  const waitingStore = await makeStore(t);
  const answeringStore = new StateStore(waitingStore.filePath);
  const bridge = makeBridge(waitingStore, new FakeTelegramApi(), {
    stateRefreshMilliseconds: 5,
  });
  t.after(() => bridge.close());
  await configureStore(waitingStore);
  await addPendingQuestion(waitingStore, {
    id: "external-answer",
    telegramMessageId: 201,
  });

  let localAnswerEvents = 0;
  bridge.on("question-answer", () => {
    localAnswerEvents += 1;
  });
  const waiting = bridge.waitForAnswer("external-answer", { waitSeconds: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  await answeringStore.update((state) => {
    const question = state.questions["external-answer"];
    question.status = "answered";
    question.answer = "Written by another process";
    question.answeredAt = "2026-07-25T12:01:00.000Z";
    question.answeredByUserId = "88";
  });

  const result = await Promise.race([
    waiting,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("External answer was not refreshed.")), 250);
    }),
  ]);
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Written by another process");
  assert.equal(localAnswerEvents, 0);
});

test("only one bridge long-polls a shared bot and another takes over after it closes", async (t) => {
  const firstStore = await makeStore(t);
  const secondStore = new StateStore(firstStore.filePath);
  const firstApi = new FakeTelegramApi();
  const secondApi = new FakeTelegramApi();
  const firstBridge = makeBridge(firstStore, firstApi, {
    pollLeaseRetryMilliseconds: 5,
  });
  const secondBridge = makeBridge(secondStore, secondApi, {
    pollLeaseRetryMilliseconds: 5,
  });
  t.after(() => firstBridge.close());
  t.after(() => secondBridge.close());
  await configureStore(firstStore);

  await Promise.all([firstBridge.initialize(), secondBridge.initialize()]);
  await waitFor(
    () => firstApi.getUpdatesCalls + secondApi.getUpdatesCalls === 1,
  );

  const [leaderBridge, followerApi] = firstApi.getUpdatesCalls === 1
    ? [firstBridge, secondApi]
    : [secondBridge, firstApi];
  await leaderBridge.close();

  await waitFor(() => followerApi.getUpdatesCalls === 1);
  assert.equal(firstApi.getUpdatesCalls + secondApi.getUpdatesCalls, 2);
});

test("askHuman waits for and returns a correlated human answer without exposing token", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api, { ids: ["blocking-question"] });
  t.after(() => bridge.close());
  await configureStore(store, { token: "123:secret-only-in-state" });
  await bridge.initialize();

  const asked = bridge.askHuman({ question: "Proceed?", waitSeconds: 1 });
  const sent = await waitFor(() => api.sentMessages.find((message) => message.text.includes("Proceed?")));
  await bridge.handleUpdate(
    telegramUpdate({ text: "Yes, proceed", replyToMessageId: sent.message_id }),
  );
  const result = await asked;

  assert.equal(result.id, "blocking-question");
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Yes, proceed");
  assert.equal(JSON.stringify(result).includes("123:secret-only-in-state"), false);
});

test("timeout preserves a durable pending question that a new bridge can resume", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api, { ids: ["restart-question"] });
  await configureStore(store);
  await bridge.initialize();

  const timedOut = await bridge.askHuman({ question: "Survive restart?", waitSeconds: 0.01 });
  assert.equal(timedOut.status, "waiting");
  assert.equal((await store.read()).questions["restart-question"].status, "pending");
  const sent = api.sentMessages.find((message) => message.text.includes("Survive restart?"));
  await bridge.close();

  const restartedApi = new FakeTelegramApi();
  const restarted = makeBridge(store, restartedApi);
  t.after(() => restarted.close());
  await restarted.initialize();
  const resumed = restarted.waitForAnswer("restart-question", { waitSeconds: 1 });
  await restarted.handleUpdate(
    telegramUpdate({ text: "Durable answer", replyToMessageId: sent.message_id }),
  );
  assert.deepEqual(await resumed, {
    id: "restart-question",
    status: "answered",
    scope: "entire_task",
    question: "Survive restart?",
    context: "",
    options: [],
    answer: "Durable answer",
    createdAt: "2026-07-25T12:00:00.000Z",
    answeredAt: "2026-07-25T12:00:00.000Z",
  });
});

test("cancelling a pending question persists cancellation and wakes waiters", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi();
  const bridge = makeBridge(store, api);
  t.after(() => bridge.close());
  await configureStore(store);
  await addPendingQuestion(store, { id: "cancel-me", telegramMessageId: 201 });
  await bridge.initialize();

  const waiting = bridge.waitForAnswer("cancel-me", { waitSeconds: 1 });
  const cancelled = await bridge.cancelQuestion("cancel-me");

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.id, "cancel-me");
  assert.equal((await waiting).status, "cancelled");
  assert.equal((await store.read()).questions["cancel-me"].cancelReason, "cancelled_by_agent");
});

test("changing the bot identity clears the trusted binding and cancels pending work", async (t) => {
  const store = await makeStore(t);
  const api = new FakeTelegramApi({ bot: { id: 456, username: "new_bot", is_bot: true } });
  const bridge = makeBridge(store, api);
  t.after(() => bridge.close());
  await configureStore(store, { botId: "123" });
  await addPendingQuestion(store, { id: "old-question", telegramMessageId: 201 });
  const waiting = bridge.waitForAnswer("old-question", { waitSeconds: 1 });

  const status = await bridge.connect("456:new-secret", { waitSeconds: 0 });
  const state = await store.read();
  assert.equal(status.bound, false);
  assert.equal(state.bot.id, "456");
  assert.equal(state.binding.chatId, null);
  assert.equal(state.questions["old-question"].status, "cancelled");
  assert.equal(state.questions["old-question"].cancelReason, "bot_reconfigured");
  assert.equal((await waiting).status, "cancelled");
  assert.equal(JSON.stringify(status).includes("456:new-secret"), false);
});

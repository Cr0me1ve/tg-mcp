import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createEmptyState } from "../src/state-store.mjs";
import { makeStore } from "./helpers.mjs";

test("StateStore serializes concurrent updates and persists their complete state", async (t) => {
  const store = await makeStore(t);

  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      store.update((state) => {
        state.questions[`q-${index}`] = { id: `q-${index}`, status: "pending" };
        state.lastUpdateId = Math.max(state.lastUpdateId, index + 1);
      }),
    ),
  );

  const persisted = await store.read();
  assert.equal(Object.keys(persisted.questions).length, 24);
  assert.equal(persisted.lastUpdateId, 24);
  assert.deepEqual(
    Object.keys(persisted.questions).sort(),
    Array.from({ length: 24 }, (_, index) => `q-${index}`).sort(),
  );
});

test("StateStore writes restrictive state and directory permissions where supported", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not portable on Windows");
  }
  const store = await makeStore(t);
  await store.update((state) => {
    state.bot.token = "should-stay-private";
  });

  const fileInfo = await stat(store.filePath);
  const directoryInfo = await stat(path.dirname(store.filePath));
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.equal(directoryInfo.mode & 0o777, 0o700);
});

test("StateStore returns isolated snapshots and normalizes absent state", async (t) => {
  const store = await makeStore(t);
  assert.deepEqual(await store.read(), createEmptyState());

  const first = await store.update((state) => {
    state.questions.one = { id: "one", status: "pending" };
  });
  first.questions.one.status = "tampered";

  const second = await store.read();
  assert.equal(second.questions.one.status, "pending");
});

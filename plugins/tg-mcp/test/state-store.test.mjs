import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { StateStore, createEmptyState } from "../src/state-store.mjs";
import { makeStore } from "./helpers.mjs";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "state-store-worker.mjs",
);

function startWorker(args) {
  const child = fork(fixturePath, args, { silent: true });
  const message = new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      reject(
        new Error(
          `StateStore worker exited before reporting (${code ?? signal ?? "unknown"}).`,
        ),
      );
    };
    child.once("message", (value) => {
      child.off("exit", onExit);
      resolve(value);
    });
    child.once("error", reject);
    child.once("exit", onExit);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `StateStore worker exited unsuccessfully (${code ?? signal ?? "unknown"}).`,
        ),
      );
    });
  });
  return { child, message, exited };
}

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

test("separate StateStore instances preserve concurrent updates to one state file", async (t) => {
  const firstStore = await makeStore(t);
  const secondStore = new StateStore(firstStore.filePath);

  const updates = Array.from({ length: 48 }, (_, index) => {
    const store = index % 2 === 0 ? firstStore : secondStore;
    return store.update((state) => {
      state.questions[`shared-${index}`] = {
        id: `shared-${index}`,
        status: "pending",
      };
    });
  });
  await Promise.all(updates);

  const persisted = await firstStore.read();
  assert.deepEqual(
    Object.keys(persisted.questions).sort(),
    Array.from({ length: 48 }, (_, index) => `shared-${index}`).sort(),
  );
});

test("separate Node processes preserve simultaneous updates to one state file", async (t) => {
  const store = await makeStore(t);
  const startPath = path.join(path.dirname(store.filePath), "start-updates");
  const workers = Array.from({ length: 8 }, (_, index) =>
    startWorker(["update", store.filePath, `process-${index}`, startPath]),
  );
  t.after(() => {
    for (const { child } of workers) {
      child.kill();
    }
  });

  assert.deepEqual(
    await Promise.all(workers.map((worker) => worker.message)),
    Array.from({ length: 8 }, () => ({ type: "ready" })),
  );
  await writeFile(startPath, "go");
  await Promise.all(workers.map((worker) => worker.exited));

  const persisted = await store.read();
  assert.deepEqual(
    Object.keys(persisted.questions).sort(),
    Array.from({ length: 8 }, (_, index) => `process-${index}`).sort(),
  );
});

test("a lease excludes other Node processes and is acquirable after release", async (t) => {
  const store = await makeStore(t);
  const releasePath = path.join(path.dirname(store.filePath), "release-lease");
  const workers = [];
  t.after(() => {
    for (const { child } of workers) {
      child.kill();
    }
  });

  const leader = startWorker([
    "lease",
    store.filePath,
    "telegram-poller",
    releasePath,
  ]);
  workers.push(leader);
  assert.deepEqual(await leader.message, { type: "lease", acquired: true });

  const contender = startWorker(["lease", store.filePath, "telegram-poller"]);
  workers.push(contender);
  assert.deepEqual(await contender.message, { type: "lease", acquired: false });
  await contender.exited;

  await writeFile(releasePath, "go");
  await leader.exited;

  const successor = startWorker(["lease", store.filePath, "telegram-poller"]);
  workers.push(successor);
  assert.deepEqual(await successor.message, { type: "lease", acquired: true });
  await successor.exited;
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

import { access } from "node:fs/promises";

import { StateStore } from "../../src/state-store.mjs";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath) {
  while (true) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await sleep(2);
    }
  }
}

const [mode, statePath, ...args] = process.argv.slice(2);
if (mode) {
  const store = new StateStore(statePath);

  if (mode === "update") {
    const [questionId, startPath] = args;
    process.send?.({ type: "ready" });
    await waitForFile(startPath);
    await store.update((state) => {
      state.questions[questionId] = { id: questionId, status: "pending" };
    });
    process.send?.({ type: "updated", questionId });
  } else if (mode === "lease") {
    const [leaseName, releasePath] = args;
    const release = await store.tryAcquireLease(leaseName);
    process.send?.({ type: "lease", acquired: Boolean(release) });
    if (release && releasePath) {
      await waitForFile(releasePath);
      await release();
    } else {
      await release?.();
    }
  } else {
    throw new Error(`Unknown worker mode: ${mode}`);
  }
}

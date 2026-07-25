import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const STATE_SCHEMA_VERSION = 1;

export function createEmptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    bot: {
      token: null,
      id: null,
      username: null,
    },
    binding: {
      chatId: null,
      userId: null,
      displayName: null,
      boundAt: null,
    },
    lastUpdateId: 0,
    questions: {},
  };
}

function normalizeState(value) {
  const empty = createEmptyState();
  if (!value || typeof value !== "object") {
    return empty;
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    bot: {
      ...empty.bot,
      ...(value.bot && typeof value.bot === "object" ? value.bot : {}),
    },
    binding: {
      ...empty.binding,
      ...(value.binding && typeof value.binding === "object"
        ? value.binding
        : {}),
    },
    lastUpdateId: Number.isSafeInteger(value.lastUpdateId)
      ? value.lastUpdateId
      : 0,
    questions:
      value.questions && typeof value.questions === "object"
        ? value.questions
        : {},
  };
}

export class StateStore {
  #filePath;
  #operation = Promise.resolve();

  constructor(filePath) {
    if (!filePath) {
      throw new Error("A state file path is required.");
    }
    this.#filePath = path.resolve(filePath);
  }

  get filePath() {
    return this.#filePath;
  }

  async read() {
    return this.#serialize(async () => structuredClone(await this.#readUnsafe()));
  }

  async update(mutator) {
    return this.#serialize(async () => {
      const current = await this.#readUnsafe();
      const draft = structuredClone(current);
      const replacement = await mutator(draft);
      const next = normalizeState(replacement ?? draft);
      await this.#writeUnsafe(next);
      return structuredClone(next);
    });
  }

  async #serialize(operation) {
    const run = this.#operation.then(operation, operation);
    this.#operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #readUnsafe() {
    try {
      const raw = await readFile(this.#filePath, "utf8");
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return createEmptyState();
      }
      if (error instanceof SyntaxError) {
        throw new Error("Telegram bridge state is not valid JSON.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async #writeUnsafe(state) {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);

    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporaryPath, 0o600).catch(() => undefined);
      await rename(temporaryPath, this.#filePath);
      await chmod(this.#filePath, 0o600).catch(() => undefined);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

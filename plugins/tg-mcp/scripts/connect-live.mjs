#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const botToken = process.env.TG_BOT_TOKEN?.trim();
if (!botToken) {
  process.stderr.write("TG_BOT_TOKEN is required.\n");
  process.exit(1);
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stateDirectory = path.resolve(
  process.env.TG_MCP_DATA_DIR ||
    path.join(os.homedir(), ".local", "share", "tg-mcp"),
);

const client = new Client({
  name: "tg-mcp-live-setup",
  version: "0.1.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "server.mjs")],
  cwd: projectRoot,
  env: {
    ...getDefaultEnvironment(),
    TG_MCP_DATA_DIR: stateDirectory,
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  process.stdout.write(
    "Telegram polling started. Send /start to the bot from the private chat to authorize.\n",
  );

  const connection = await client.callTool(
    {
      name: "telegram_connect",
      arguments: {
        bot_token: botToken,
        wait_seconds: 600,
      },
    },
    undefined,
    { timeout: 620_000 },
  );
  const connectionStatus = connection.structuredContent;
  if (connection.isError || connectionStatus?.status !== "ready") {
    throw new Error(
      connectionStatus?.error ||
        "Telegram was not authorized with /start before the timeout.",
    );
  }

  process.stdout.write(
    "Telegram chat authorized. A live test question was sent; reply to it in Telegram.\n",
  );
  const answer = await client.callTool(
    {
      name: "ask_human",
      arguments: {
        question:
          "Live-проверка tg-mcp: ответьте на это сообщение любым текстом.",
        context:
          "Ответ нужен только для проверки доставки вопроса и продолжения работы агента.",
        scope: "entire_task",
        wait_seconds: 600,
      },
    },
    undefined,
    { timeout: 620_000 },
  );
  const answerStatus = answer.structuredContent;
  if (answer.isError || answerStatus?.status !== "answered") {
    throw new Error(
      answerStatus?.error ||
        "The live Telegram question was not answered before the timeout.",
    );
  }

  process.stdout.write(
    "Live Telegram round trip passed. The authorized chat is persisted.\n",
  );
} finally {
  await client.close().catch(() => undefined);
}

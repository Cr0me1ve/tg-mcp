#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "tg-mcp-smoke-"),
);

const client = new Client({
  name: "tg-mcp-smoke",
  version: "0.1.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "dist", "server.mjs")],
  cwd: projectRoot,
  env: {
    ...getDefaultEnvironment(),
    TG_MCP_DATA_DIR: temporaryDirectory,
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  const expected = [
    "ask_human",
    "cancel_question",
    "telegram_connect",
    "telegram_status",
    "wait_for_answer",
  ];

  if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected MCP tools: ${toolNames.join(", ")}`);
  }

  const statusResult = await client.callTool({
    name: "telegram_status",
    arguments: {},
  });
  const status = statusResult.structuredContent;
  if (status?.connected !== false || status?.bound !== false) {
    throw new Error(`Unexpected initial status: ${JSON.stringify(status)}`);
  }

  const unconfiguredQuestion = await client.callTool({
    name: "ask_human",
    arguments: {
      question: "Smoke-test question",
      scope: "entire_task",
      wait_seconds: 1,
    },
  });
  if (
    unconfiguredQuestion.isError !== true ||
    !unconfiguredQuestion.content?.some(
      (item) =>
        item.type === "text" && item.text.includes("telegram_connect"),
    )
  ) {
    throw new Error("Unconfigured ask_human did not fail safely.");
  }

  process.stdout.write(
    `MCP smoke test passed (${toolNames.length} tools, clean initial state, safe preflight error).\n`,
  );
} finally {
  await client.close().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

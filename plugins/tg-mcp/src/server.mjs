#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { HumanBridge } from "./human-bridge.mjs";
import { StateStore } from "./state-store.mjs";

const VERSION = "0.2.0";

function dataDirectory(environment = process.env) {
  return path.resolve(
    environment.TG_MCP_DATA_DIR ||
      environment.PLUGIN_DATA ||
      path.join(os.homedir(), ".local", "share", "tg-mcp"),
  );
}

function toolResult(payload, { isError = false } = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function safeError(error) {
  if (error?.name === "AbortError") {
    return "The wait was interrupted. The durable question may still be pending.";
  }
  return error?.message || "Telegram bridge operation failed.";
}

function guarded(handler) {
  return async (args, extra) => {
    try {
      return toolResult(await handler(args, extra));
    } catch (error) {
      return toolResult(
        {
          status: "error",
          error: safeError(error),
        },
        { isError: true },
      );
    }
  };
}

export function createServer(bridge) {
  const server = new McpServer({
    name: "telegram-human-bridge",
    version: VERSION,
  });

  server.registerTool(
    "telegram_connect",
    {
      title: "Connect Telegram bot",
      description:
        "Validate and store a Telegram bot token, start long polling, and wait for the first private /start message. The first private chat to send /start becomes the only authorized chat.",
      inputSchema: {
        bot_token: z
          .string()
          .min(20)
          .describe("Telegram bot token received from BotFather."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .default(300)
          .describe("How long to wait for /start before returning."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    guarded(async ({ bot_token, wait_seconds }, extra) => {
      const status = await bridge.connect(bot_token, {
        waitSeconds: wait_seconds,
        signal: extra.signal,
      });
      return {
        status: status.bound ? "ready" : "waiting_for_start",
        ...status,
        instruction: status.bound
          ? "Telegram is ready for human questions."
          : "Open the bot in Telegram and send /start from the private chat that should be authorized.",
      };
    }),
  );

  server.registerTool(
    "telegram_status",
    {
      title: "Telegram bridge status",
      description:
        "Report bot, binding, polling, and pending-question status without exposing the bot token or chat id.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    guarded(async () => bridge.status()),
  );

  server.registerTool(
    "ask_human",
    {
      title: "Ask the authorized human",
      description:
        "Send a blocking question to the authorized Telegram chat and wait for its answer. For scope=workstream this tool must be called by a dedicated subagent while the main agent continues independent work. Telegram answers are information, not sandbox approval or authorization for destructive actions.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .max(4000)
          .describe("One concrete question whose answer unblocks work."),
        context: z
          .string()
          .max(8000)
          .default("")
          .describe("Concise context needed to make the decision."),
        options: z
          .array(z.string().min(1).max(500))
          .max(10)
          .default([])
          .describe("Optional suggested answers."),
        scope: z
          .enum(["entire_task", "workstream"])
          .default("entire_task")
          .describe(
            "Whether the answer blocks the whole task or only one independent workstream.",
          ),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(86400)
          .default(3600)
          .describe("How long this MCP call should wait for the reply."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    guarded(
      async (
        { question, context, options, scope, wait_seconds },
        extra,
      ) =>
        bridge.askHuman(
          {
            question,
            context,
            options,
            scope,
            waitSeconds: wait_seconds,
          },
          { signal: extra.signal },
        ),
    ),
  );

  server.registerTool(
    "wait_for_answer",
    {
      title: "Wait for an existing answer",
      description:
        "Resume waiting for a durable Telegram question after a previous MCP wait timed out or was interrupted.",
      inputSchema: {
        question_id: z.string().min(1),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(86400)
          .default(3600),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    guarded(async ({ question_id, wait_seconds }, extra) =>
      bridge.waitForAnswer(question_id, {
        waitSeconds: wait_seconds,
        signal: extra.signal,
      }),
    ),
  );

  server.registerTool(
    "cancel_question",
    {
      title: "Cancel a pending question",
      description:
        "Cancel one durable pending Telegram question when its answer is no longer needed.",
      inputSchema: {
        question_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    guarded(async ({ question_id }) => bridge.cancelQuestion(question_id)),
  );

  return server;
}

export async function main(environment = process.env) {
  const store = new StateStore(
    path.join(dataDirectory(environment), "state.json"),
  );
  const bridge = new HumanBridge({ store });
  await bridge.initialize();

  if (environment.TG_BOT_TOKEN) {
    await bridge.connect(environment.TG_BOT_TOKEN, { waitSeconds: 0 });
  }

  const server = createServer(bridge);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await bridge.close();
    await server.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`tg-mcp failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

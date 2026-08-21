import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("plugin MCP launch config uses the packaged server relative to the plugin root", async () => {
  const config = JSON.parse(await readFile(resolve(pluginRoot, ".mcp.json"), "utf8"));
  const server = config.mcpServers?.["telegram-human-bridge"];

  assert.deepEqual(server, {
    command: "node",
    args: ["./dist/server.mjs"],
    cwd: ".",
    tool_timeout_sec: 86460,
  });
  assert.equal(JSON.stringify(server).includes("${PLUGIN_ROOT}"), false);
  await access(resolve(pluginRoot, "dist/server.mjs"));
});

# tg-mcp plugin package

This directory contains the packaged Codex plugin: its manifest, MCP server,
human-escalation skill, and development tooling. For installation and user
setup, see the [repository README](../../README.md).

## Development

Contributors need Node.js 20 or later. From this directory:

```sh
npm install
npm run build
npm test
npm run smoke
```

Available commands:

| Command | Purpose |
| --- | --- |
| `npm run build` | Bundles `src/server.mjs` into `dist/server.mjs`, the file started by the plugin MCP configuration. |
| `npm start` | Runs the source MCP server over stdio. |
| `npm test` | Runs the Node test suite. |
| `npm run smoke` | Runs the MCP stdio protocol smoke test. |
| `npm run connect` | Performs a manual live Telegram round trip using configured local credentials. |

The plugin configuration is [`.mcp.json`](.mcp.json); it runs
`${PLUGIN_ROOT}/dist/server.mjs`. Build before testing an installed plugin
locally.

## Local Telegram verification

For a live check, supply a bot token through the process environment and run
`npm run connect`. Then send `/start` from the intended private Telegram chat
and reply to the test question. Do not commit, paste, or log the token or a
chat ID.

The server's state directory can be overridden with `TG_MCP_DATA_DIR`; this is
useful for isolated local testing. State includes sensitive connection material,
so keep it private.

## Package boundaries

The server exposes five MCP tools: `telegram_connect`, `telegram_status`,
`ask_human`, `wait_for_answer`, and `cancel_question`. The associated skill
instructs Codex to isolate a partially blocked workstream in a waiting subagent
while independent work continues. Telegram answers are informational and must
not be treated as authorization for sandbox or destructive operations.

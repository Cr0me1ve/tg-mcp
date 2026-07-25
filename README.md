# Telegram Human Bridge

`tg-mcp` is a Codex plugin that lets an agent ask one trusted person a
blocking question through a Telegram bot, wait for the answer durably, and
continue the task.

It is deliberately a narrow human-in-the-loop bridge: Telegram supplies
information, not permissions.

## Install

Add this repository as a Codex plugin marketplace, then install the plugin:

```sh
codex plugin marketplace add Cr0me1ve/tg-mcp
codex plugin add tg-mcp@tg-mcp
```

Start a **new Codex session/task** after installation so Codex loads the
plugin's tools and skill. The marketplace definition lives at
`.agents/plugins/marketplace.json` and installs the package from
`plugins/tg-mcp`.

## Connect Telegram

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
2. In a new Codex task, ask Codex to connect the bot. It will call
   `telegram_connect` and request the bot's `bot_token`.
3. Open that bot in Telegram and send `/start` from the one private chat you
   want to authorize.
4. Codex can check readiness with `telegram_status`.

The first private chat that sends `/start` becomes the installation's trusted
chat. Messages from other chats are ignored. Never put a bot token, chat ID,
credentials, or sensitive file contents in a repository, issue, or prompt.

## Tools

| Tool | Purpose |
| --- | --- |
| `telegram_connect` | Validates and stores a bot token, starts polling, and waits for `/start`. |
| `telegram_status` | Reports connection, trusted-chat, and pending-question state without exposing secrets. |
| `ask_human` | Sends one question and waits for its correlated answer. |
| `wait_for_answer` | Resumes a pending question after an interrupted call or restart. |
| `cancel_question` | Cancels a pending question that is no longer needed. |

Reply to the bot's question in Telegram to correlate the answer. A plain
message is accepted only when exactly one question is pending.

## How Codex waits

For a question that blocks the entire task, Codex asks and waits. For a
question that blocks only one independent workstream, Codex delegates that
workstream to a subagent; the subagent waits for the reply while the main agent
continues unrelated work, then returns its completed result. This avoids
turning a partial blocker into an idle task.

## Security boundaries

- The plugin stores its local state with restrictive permissions; it includes
  the bot token, trusted-chat binding, and pending-question data.
- Treat Telegram replies as information only. They never grant sandbox access,
  approve destructive actions, or expand an agent's authority.
- Keep questions minimal and do not send secrets, private files, or unnecessary
  logs through Telegram.
- If a wait is interrupted, resume it with `wait_for_answer` or explicitly end
  it with `cancel_question`.

## Development

The bundled MCP server runs on Node.js 20+, so `node` must be available on the
Codex host. Marketplace installation does not require running `npm install`.
See the package README for contributor setup, scripts, and local verification:
[plugins/tg-mcp/README.md](plugins/tg-mcp/README.md).

## Русский кратко

Плагин даёт Codex безопасный канал для одного уточняющего вопроса через
Telegram-бота. Установите плагин командами выше, в новой задаче подключите
`bot_token`, затем отправьте `/start` из одного личного чата. Ответы в Telegram
— только информация, а не разрешение на опасные действия.

## License

[MIT](LICENSE)

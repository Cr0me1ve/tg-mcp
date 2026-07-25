# Telegram Human Bridge MVP

## Goal

Build a local Codex plugin whose MCP server can contact one trusted person
through a Telegram bot when an agent needs information, wait durably for the
reply, and let the Codex task continue.

## Product requirements

1. The first connection requires a Telegram `bot_token`.
2. After receiving the token, the MCP server starts Telegram long polling and
   waits for a user to send `/start`.
3. The first accepted `/start` binds the installation to that Telegram
   `chat_id`. Later messages from other chats are ignored.
4. The binding and pending questions survive MCP server restarts.
5. Blocking questions are sent to the bound chat and correlated with replies.
6. A question that blocks the entire task may pause the main agent until the
   reply arrives.
7. A question that blocks only one independent workstream must be delegated to
   a subagent. That subagent waits for the Telegram reply while the main agent
   continues other independent work, then the main agent collects the
   subagent's result.
8. Bot tokens and Telegram messages must not be written to normal application
   logs. Secret storage must use restrictive file permissions.
9. Telegram answers provide information only; they do not automatically grant
   sandbox permissions or authorize destructive actions.

## Architecture

- A Codex plugin packages:
  - an MCP server;
  - a skill describing when and how agents ask a human;
  - optional lifecycle hooks only where deterministic enforcement is useful.
- The MCP server is a Node.js stdio server.
- Telegram communication uses the Bot API with long polling.
- A local JSON state file under `PLUGIN_DATA` (or an explicit data directory)
  stores the bound chat and durable questions. Writes are atomic.
- MCP tools:
  - `telegram_connect`: validate and persist a bot token, start polling, and
    report that `/start` is required.
  - `telegram_status`: report connection, binding, and pending-question state
    without exposing secrets.
  - `ask_human`: send a question and wait for its correlated answer.
  - `wait_for_answer`: resume waiting for a durable pending question after an
    interrupted MCP call or server restart.
  - `cancel_question`: cancel a pending question.
- Telegram replies are correlated using reply-to-message metadata. When only
  one question is pending, a plain message may answer that question.

## Delivery plan

1. Scaffold and validate the plugin structure.
2. Implement durable state and Telegram Bot API polling.
3. Implement the MCP tools and safe single-chat binding.
4. Add the Codex skill, including the partial-blocker subagent workflow.
5. Add focused tests for state, authorization, correlation, cancellation, and
   restart behavior.
6. Run unit tests, plugin validation, and an MCP protocol smoke test.
7. Document only the minimal setup and manual Telegram verification steps
   needed for the MVP.

## Future requirements

Add new user requirements to this section as they are introduced. If a new
requirement changes an earlier decision, update the relevant section above and
record the change here.

- Run the live Telegram connection using the user-supplied bot token, wait for
  the authorized user to send `/start`, and verify a real question/reply round
  trip without recording the token in repository files or normal logs.
- Package and install the MVP as a personal Codex plugin so its MCP tools and
  human-escalation skill are available to new tasks in every project.
- Publish the plugin in a public GitHub repository as a repo marketplace so
  any Codex user can add the marketplace and install `tg-mcp`.

## Implementation status

- Plugin manifest, MCP wiring, skill, durable state, Telegram polling, and all
  five MCP tools are implemented.
- Offline unit tests and the MCP stdio smoke test are implemented.
- Plugin and skill validators pass.
- Live Telegram verification passed: the supplied bot token was accepted, the
  first private `/start` bound one chat, and a real question/reply round trip
  completed. The authorized chat is persisted for future MCP sessions.
- The plugin is installed and enabled from the personal Codex marketplace, so
  new tasks in every project can load both the MCP tools and the escalation
  skill.
- The public marketplace is published at
  `https://github.com/Cr0me1ve/tg-mcp`; a fresh Git-backed Codex installation
  loads the bundled MCP without `node_modules` and exposes all five tools.

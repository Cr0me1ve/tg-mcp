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
10. Multiple Codex chats and projects may ask questions concurrently through
    the same bot. Exactly one local process may poll Telegram at a time,
    shared state updates must be safe across processes, and every waiting
    process must observe answers written by the poller process.
11. When exactly one question is pending, a plain Telegram message answers it.
    When two or more questions are pending, only a reply to the corresponding
    Telegram question is accepted.
12. Questions with suggested options show those options as an inline Telegram
    keyboard. The trusted person may still answer any question with text.
13. Reply-correlation and safety guidance is sent once when the trusted chat is
    first bound with `/start`, rather than repeated under each question or in
    follow-up reminder messages.
14. After marketplace installation, every new local Codex task receives the
    bridge's five MCP tools without a manual server launch or project-specific
    configuration. Packaged server paths must resolve from the installed
    plugin root.

## Architecture

- A Codex plugin packages:
  - an MCP server;
  - a skill describing when and how agents ask a human;
  - optional lifecycle hooks only where deterministic enforcement is useful.
- The MCP server is a Node.js stdio server.
- The plugin MCP configuration starts the bundled server from the installed
  plugin root using a relative path and an explicit plugin-root working
  directory; it does not depend on host-side placeholder expansion.
- Telegram communication uses the Bot API with long polling. A renewable
  filesystem lease elects one poller across all local MCP processes, with
  automatic failover when the leader exits.
- A local JSON state file under `PLUGIN_DATA` (or an explicit data directory)
  stores the bound chat and durable questions. Writes are atomic and guarded
  by an inter-process lock.
- Waiting MCP processes observe both local events and durable state changes, so
  an answer consumed by another process wakes the correct Codex task.
- MCP tools:
  - `telegram_connect`: validate and persist a bot token, start polling, and
    report that `/start` is required.
  - `telegram_status`: report connection, binding, and pending-question state
    without exposing secrets.
  - `ask_human`: send a question and wait for its correlated answer.
  - `wait_for_answer`: resume waiting for a durable pending question after an
    interrupted MCP call or server restart.
  - `cancel_question`: cancel a pending question.
- Telegram replies are correlated using reply-to-message metadata, while
  inline option callbacks identify the question directly. When only one
  question is pending, a plain message may answer that question.

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
- Support concurrent questions from multiple Codex chats and projects through
  one Telegram bot: require replies when several questions are pending, allow
  plain text when only one is pending, and avoid competing Telegram pollers.
- Present suggested answers as inline Telegram buttons while preserving text
  answers, and send usage guidance only on the first successful `/start` bind.
- Make the installed plugin's MCP tools available automatically in every new
  local Codex task, with an installed-package launch regression test.

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
- Version 0.2.0 coordinates concurrent Codex chats on one host with an
  inter-process state lock, a single renewable Telegram poller lease with
  failover, and durable answer observation by every waiting process. Plain
  messages are accepted for one pending question; multiple pending questions
  require replies to their corresponding Telegram messages.
- Suggested answers are rendered as inline buttons, while custom text remains
  available. Usage and safety guidance is sent once when `/start` first binds
  the trusted chat and is not repeated under questions.
- The packaged MCP server now starts from `cwd: "."` with the relative
  `./dist/server.mjs` path, so installed plugins expose all five tools without
  relying on unsupported `${PLUGIN_ROOT}` expansion. A clean Codex session
  successfully called `telegram_status` through the reinstalled plugin.
- Version 0.3.0 packages the inline-answer UX, one-time binding guidance, and
  installed MCP launch fix for the public marketplace release.

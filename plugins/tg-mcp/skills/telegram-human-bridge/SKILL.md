---
name: telegram-human-bridge
description: Keep Codex work moving when a human decision or missing information is required by asking one trusted person through Telegram; isolate partial blockers in a waiting subagent so the main agent can continue independent work.
---

# Telegram human bridge

Use this workflow when work is genuinely blocked on information or a decision
that only a person can provide.

## Before asking

Do not contact the person on the first error. First exhaust safe, in-scope
paths that do not require new authority:

1. Inspect the error and relevant local context.
2. Check repository instructions and documentation.
3. Try safe alternatives that preserve the requested outcome.
4. Reduce the uncertainty to one concrete question.

Ask the person when continuing would require guessing about intent, obtaining a
missing secret, waiting for an external action, or expanding authority. Never
use a Telegram answer as sandbox approval or authorization for a destructive
action; use the normal Codex approval path for that.

## Connect Telegram

Call `telegram_status` before the first question.

If no bot is connected:

1. Request the `bot_token` from the user without asking them to commit it to the
   repository.
2. Call `telegram_connect` with the token. Do not repeat the token in messages,
   logs, summaries, or files.
3. Tell the user to open the bot in a private Telegram chat and send `/start`.
   The connection call waits for this message.
4. Confirm that the returned status is `ready`. The first private chat that
   sends `/start` is the only chat the bridge will accept.

## Classify the blocker

Classify every question before sending it:

- `entire_task`: no meaningful requested work can continue without the answer.
- `workstream`: only one independent branch is blocked and useful work remains
  elsewhere.

### Entire-task blocker

The main agent calls `ask_human` with `scope: "entire_task"` and waits for the
answer. Continue the original task as soon as the answer arrives.

### Workstream blocker

The main agent MUST delegate the blocked branch to a new subagent when a
subagent tool is available:

1. Give the subagent ownership only of the blocked workstream and any
   non-overlapping files it may change.
2. State that other agents are working in the repository and it must not revert
   their edits.
3. Give it the exact question, concise context, and useful options.
4. Require it to call `ask_human` with `scope: "workstream"` and wait for the
   answer.
5. Require it to finish the blocked workstream after the answer and report its
   result to the main agent.
6. While that subagent waits, the main agent continues every independent piece
   of useful work available.
7. After independent work is exhausted, join or wait for the subagent and
   integrate its result.

Do not make the main agent wait immediately after spawning the subagent if
independent work is available. Do not duplicate the subagent's assigned work.

If subagents are unavailable, continue all independent work first, then call
`ask_human` from the main agent and clearly note this fallback.

## Asking well

Every `ask_human` call should contain:

- one decision or missing fact;
- enough context to answer without reading the whole transcript;
- short options when there are a few realistic choices;
- no credentials, private file contents, or irrelevant logs.

If a wait times out or is interrupted, reuse its `question_id` with
`wait_for_answer`. Do not create duplicate Telegram questions. If the answer is
no longer needed, call `cancel_question`.

Suggested options appear as inline Telegram buttons, and the person may always
write a custom text answer instead. When exactly one Telegram question is
pending, a plain message answers it. When two or more questions are pending
across Codex tasks, custom text answers must be Telegram replies to the
corresponding question message. The bridge correlates buttons by question ID
and text replies by Telegram message ID.

A pending question means the affected work is still incomplete. Never report
that workstream or the overall task as complete until the answer has been
handled or the question has been explicitly cancelled because a safe
alternative removed the blocker.

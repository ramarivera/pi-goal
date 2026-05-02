# Pi Goal / Ralph Loop Context Research

Date: 2026-05-02

## Repository Pins

| Repo | Local path | Remote | Commit used |
| --- | --- | --- | --- |
| OpenAI Codex | `.context/codex` | `https://github.com/openai/codex.git` | `rust-v0.128.0` tag: `e4310be51f`; current clone HEAD: `35aaa5d9fc` |
| Pi Mono | `.context/pi-mono` | `https://github.com/badlogic/pi-mono.git` | `588639fa` |
| SST opencode | `.context/opencode` | `https://github.com/sst/opencode.git` | `43e20874f` |

## Short Conclusion

Pi does not need a new core primitive to implement a solid Codex-style goal/Ralph loop as an extension.

The extension-level implementation should use hidden custom messages with `display: false` plus `triggerTurn: true`, scheduled after the current `agent_end` listener unwinds. A core primitive would still be cleaner for exact Codex parity, but the source evidence says it is not strictly required.

## Codex Goal Implementation Shape

Codex `rust-v0.128.0` implements goals as first-class persisted runtime state, not just prompt text.

Observed facts:

- `thread_goals` is a persisted SQLite table keyed by `thread_id`, with `goal_id`, `objective`, `status`, optional `token_budget`, `tokens_used`, `time_used_seconds`, and timestamps in `.context/codex/codex-rs/state/migrations/0029_thread_goals.sql:1`.
- The goal status enum supports `active`, `paused`, `budget_limited`, and `complete`; budget-limited and complete are terminal in `.context/codex/codex-rs/state/src/model/thread_goal.rs:11`.
- Runtime events include turn start, tool completion, turn finish, idle continuation checks, aborts, external mutation, and thread resume in `.context/codex/codex-rs/core/src/goals.rs:73`.
- Continuation scheduling checks that there is no active turn, no queued next-turn input, no trigger-turn mailbox input, and no continuation suppression from the previous no-tool continuation before starting another turn in `.context/codex/codex-rs/core/src/goals.rs:1150`.
- Codex reserves an active turn, re-checks that the goal is still current, pushes a hidden developer continuation item, marks the continuation turn started, and starts a task in `.context/codex/codex-rs/core/src/goals.rs:1164`.
- The continuation prompt treats the objective as untrusted data, includes budget context, requires a completion audit, and tells the model to call `update_goal` only when the objective is actually complete in `.context/codex/codex-rs/core/templates/goals/continuation.md:1`.
- Model tool handlers intentionally split creation and completion: `create_goal` starts an objective; `update_goal` only permits `complete`, while pause/resume/budget-limited are user/system controlled in `.context/codex/codex-rs/core/src/tools/handlers/goal.rs:1`.

Inference:

- Codex's core feature is robust because scheduling, persistence, budget accounting, UI status, and model tools all share one runtime-owned state machine.

## Pi API Mapping

Pi has enough extension primitives to emulate the feature.

Observed facts:

- Pi custom messages have `role: "custom"`, arbitrary `customType`, `content`, and `display` in `.context/pi-mono/packages/coding-agent/src/core/messages.ts:46`.
- Custom messages are converted into LLM-visible user messages regardless of `display`, so hidden messages can steer the model while staying out of the TUI in `.context/pi-mono/packages/coding-agent/src/core/messages.ts:148`.
- The interactive UI suppresses custom messages when `display` is false in `.context/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3005`.
- `sendCustomMessage` supports `triggerTurn` and `deliverAs: "steer" | "followUp" | "nextTurn"` in `.context/pi-mono/packages/coding-agent/src/core/agent-session.ts:1261`.
- When not streaming and `triggerTurn` is true, `sendCustomMessage` calls `agent.prompt(appMessage)` in `.context/pi-mono/packages/coding-agent/src/core/agent-session.ts:1293`.
- When streaming, `sendCustomMessage` queues as steering or follow-up; `deliverAs: "nextTurn"` stores in `_pendingNextTurnMessages` in `.context/pi-mono/packages/coding-agent/src/core/agent-session.ts:1285`.
- Extension APIs expose `before_agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_end`, tool events, `registerTool`, `registerCommand`, `sendMessage`, `sendUserMessage`, and `appendEntry` in `.context/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1100`.
- `appendEntry` persists custom state that is not sent to the LLM in `.context/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1192`.
- `CustomMessageEntry` persists hidden/displayed extension messages and participates in LLM context in `.context/pi-mono/packages/coding-agent/src/core/session-manager.ts:120`.
- Pi's `agent_end` event is not the idle boundary: awaited `agent_end` listeners are still part of the active run in `.context/pi-mono/packages/agent/src/agent.ts:216`.
- `finishRun()` clears `isStreaming` and `activeRun` only after event listeners settle in `.context/pi-mono/packages/agent/src/agent.ts:480`.
- The plan-mode extension already uses `before_agent_start` hidden context and starts an execution turn with a custom message and `{ triggerTurn: true }` in `.context/pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts:158` and `.context/pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts:278`.
- The tic-tac-toe extension starts an agent response from a custom message with `{ triggerTurn: true }` in `.context/pi-mono/packages/coding-agent/examples/extensions/tic-tac-toe.ts:819`.

Inference:

- A goal extension can persist goal state with `appendEntry`, expose `/goal` commands with `registerCommand`, expose model-facing `get_goal`, `create_goal`, and `update_goal` with `registerTool`, inject continuation/audit context via hidden custom messages, and trigger the next turn with `sendMessage(..., { triggerTurn: true })`.
- Because `agent_end` listeners run before `finishRun()`, the extension should defer the trigger-turn call with `queueMicrotask`, `setTimeout(..., 0)`, or an equivalent post-settlement scheduler. Calling `sendMessage(..., { triggerTurn: true })` synchronously inside `agent_end` risks hitting the still-streaming path or queueing semantics instead of starting a clean new turn.

## Opencode Prior Art

Opencode does not appear to provide a persisted goal/Ralph-loop feature, but it shows adjacent loop mechanics.

Observed facts:

- The session prompt flow creates a user message, then calls the session loop unless `noReply` is true in `.context/opencode/packages/opencode/src/session/prompt.ts:1256`.
- The session loop keeps running while assistant/tool/compaction work requires continuation and exits when the latest assistant has a terminal finish, no pending tool calls, and the latest user is older than that assistant in `.context/opencode/packages/opencode/src/session/prompt.ts:1293`.
- Auto-compaction can synthesize a user message that tells the model to continue or stop and ask for clarification; the synthetic text part is marked with metadata and `synthetic: true` in `.context/opencode/packages/opencode/src/session/compaction.ts:476`.
- The processor returns `"continue"`, `"compact"`, or `"stop"` depending on stream/tool state in `.context/opencode/packages/opencode/src/session/processor.ts:27` and `.context/opencode/packages/opencode/src/session/processor.ts:539`.

Inference:

- Opencode validates the general pattern of internal/synthetic user messages for continuation, but it is less directly applicable to Pi than Pi's own custom-message extension surface.

## Recommended Pi Extension Design

Implement as an extension first.

State:

- Persist a custom entry such as `goal-state` with `goalId`, `objective`, `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`, `createdAt`, `updatedAt`, `lastContinuationHadToolCall`, and `continuationScheduled`.
- Reconstruct the current goal by scanning the session entries for the latest `goal-state` entry on load/resume.

Commands:

- `/goal <objective>` creates or replaces only when no active goal exists unless explicitly confirmed by user command behavior.
- `/goal status` displays current state.
- `/goal pause`, `/goal resume`, and `/goal clear` remain user-controlled.

Model tools:

- `get_goal`: returns current goal and remaining budget.
- `create_goal`: creates an active goal when no goal exists.
- `update_goal`: only accepts `{ status: "complete" }`, mirroring Codex's safety split.

Loop:

- On `turn_start`, mark active timing/accounting start.
- On `tool_execution_end`, record that this continuation did useful work.
- On `turn_end` or `message_end`, accumulate usage if Pi exposes assistant usage consistently in the event payload.
- On `agent_end`, if goal is active, no queued user input is known, budget remains, and last continuation was not suppressed, schedule a deferred hidden continuation:

```ts
setTimeout(() => {
  pi.sendMessage(
    {
      customType: "goal-continuation",
      content: renderContinuationPrompt(goal),
      display: false,
      details: { goalId: goal.goalId },
    },
    { triggerTurn: true },
  );
}, 0);
```

Prompt:

- Closely follow Codex's `continuation.md`: objective as untrusted data, budget context, "choose the next concrete action", and a strict completion audit before calling `update_goal`.

Guardrails:

- Suppress continuation after a continuation turn that made no tool calls, unless user input resumes it.
- Do not continue while plan/read-only mode is active.
- Prefer user/system ownership for pause/resume/budget-limited.
- Avoid transcript bloat by pruning or compacting old continuation custom messages if Pi context hooks permit safe filtering.

## Core Primitive Tradeoff

Not strictly needed:

- Hidden LLM-visible messages already exist.
- Trigger-turn from custom messages already exists.
- Persistent custom entries already exist.
- Extension hooks cover the lifecycle and tool events.

Still useful for polish:

- A first-class "start hidden continuation turn after idle" primitive would avoid timer scheduling.
- Runtime-owned idle/queue checks would be less racy than extension-level heuristics.
- Native budget accounting could be more accurate than extension-level usage scraping.
- Developer-role continuation messages would match Codex more closely than Pi custom messages converted as user-role messages.

## Open Questions For Implementation

- Whether `ctx` exposes a public way to inspect pending user/steering/follow-up queues from an extension. If not, the extension should maintain its own `input`/`sendUserMessage` observations and rely on Pi's queue behavior.
- Exact assistant usage shape in current Pi events should be verified with a small extension smoke test before final budget accounting.
- Whether Pi context hooks can prune hidden `goal-continuation` messages before provider request without losing session auditability.

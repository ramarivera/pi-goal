# Pi Goal Extension

This repo includes a project-local Pi extension at `.pi/extensions/pi-goal/index.ts`.

The extension implements a Codex-inspired persisted goal continuation without patching Pi core.

## Install Location

Pi discovers project-local extensions from:

```text
.pi/extensions/<extension-name>/index.ts
```

This extension is already in that shape:

```text
.pi/extensions/pi-goal/index.ts
```

The publishable package registers the canonical `/goal` command and `get_goal`, `create_goal`, and `update_goal` tools. The project-local shim registers prefixed names so this repository can be opened while the published package is installed globally:

```text
/local-goal
local_get_goal
local_create_goal
local_update_goal
```

## User Commands

```text
/goal <objective>
/goal <objective> --budget 10000
/goal <objective> --budget=10000
/goal status
/goal pause
/goal resume
/goal clear
```

In this repository's project-local extension, use `/local-goal` with the same subcommands and arguments.

When `/goal <objective>` or `/local-goal <objective>` creates a new goal, the extension first persists the goal state and then submits the objective as a user message. If the agent is idle, the message starts immediately; if a turn is already running, it is queued as a follow-up.

Recoverable provider/runtime errors automatically re-apply pressure while a goal is active and incomplete. This means a long-running goal should not stop just because a transient model/API/runtime error happened while Ramiro is away.

`/goal resume` is still a manual pressure button. If the goal is paused, it marks it active and schedules hidden continuation pressure. If the goal is already active but stalled, `/goal resume` clears suppression and schedules the hidden continuation again instead of merely restating the active state.

## Model Tools

The extension registers three model tools:

- `get_goal`: returns the current goal or no-goal response.
- `create_goal`: creates one active goal when no active or paused goal exists.
- `update_goal`: only accepts `{ "status": "complete" }`.

Pause, resume, clear, and budget-limited transitions stay user/system controlled.

In interactive Pi sessions, `/goal status` opens a compact overlay instead of writing the full report into chat. It includes readable elapsed time, active-goal turn count, hidden continuation instruction count, input/output/reasoning/cache token breakdowns, cost totals, budget remaining, and per-model usage rollups when the provider exposes those fields. In non-interactive modes, the command keeps the same plain text notification fallback.

## Continuation Behavior

When a goal is active, the extension schedules a continuation after `agent_end` settles by sending a hidden custom message:

```js
pi.sendMessage(
  {
    customType: "pi-goal-continuation",
    content: renderContinuationPrompt(goal),
    display: false,
    details: { goalId },
  },
  { triggerTurn: true },
);
```

The default continuation scheduler waits briefly before firing to avoid racing provider recovery or compaction cleanup. Override the delay with `PI_GOAL_CONTINUATION_DELAY_MS` when debugging.

If an assistant message ends with a recoverable `stopReason: "error"`, the extension schedules hidden continuation pressure automatically. Authentication, missing key, permission, consent, and equivalent human-required errors are treated as non-recoverable and are not auto-pressured.

If Pi still reports the agent as busy when pressure is sent, the extension uses follow-up delivery:

```js
pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
```

The extension deliberately does not call `agent.continue()` from an assistant-terminal state.

## Structured Tracing

The extension emits Pino JSON traces to `~/.pi/logs/pi-goal.log` by default. Set `PI_GOAL_LOG_LEVEL=debug` when investigating continuation behavior.

Useful knobs:

```text
PI_GOAL_LOG_LEVEL=debug
PI_GOAL_LOG_FILE=/tmp/pi-goal.log
PI_GOAL_LOG_FILE=stdout
PI_GOAL_LOG=0
```

Trace events cover command handling, model tool calls, state persistence, objective auto-submit delivery mode, lifecycle hooks, context pruning, continuation block reasons, hidden trigger sends, turn accounting, and budget exhaustion. Logs avoid writing full objective text or hidden continuation prompt bodies; use goal ids and counters to correlate events.

## Guardrails

- The continuation prompt treats the objective as untrusted user data.
- The continuation prompt explicitly identifies itself as an internal hidden `pi-goal` continuation, not a new human/user message.
- The model must perform a completion audit before calling `update_goal`.
- No-tool continuation turns suppress further automatic continuation.
- Paused, complete, budget-limited, cleared, or absent goals do not continue.
- Plan/read-only mode suppresses continuation when detected.
- Token budget exhaustion marks the goal `budget_limited`.

## Context Hygiene

The extension prunes stale `pi-goal-continuation` messages for old goals from future context while keeping the current active goal's continuation message available. This keeps auditability for the active loop without accumulating old hidden prompts indefinitely.

## Verification

Run:

```sh
npm test
npm run typecheck
npm run lint
openspec validate add-pi-goal --strict
```

`npm test` includes a Pi SDK e2e check that loads the project-local extension through
`DefaultResourceLoader`, creates an in-memory `AgentSession`, runs `/local-goal` commands,
and verifies the persisted `pi-goal-state` custom entries.

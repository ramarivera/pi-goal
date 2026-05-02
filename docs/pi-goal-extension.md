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

## Model Tools

The extension registers three model tools:

- `get_goal`: returns the current goal or no-goal response.
- `create_goal`: creates one active goal when no active or paused goal exists.
- `update_goal`: only accepts `{ "status": "complete" }`.

Pause, resume, clear, and budget-limited transitions stay user/system controlled.

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

The extension deliberately does not call `agent.continue()` from an assistant-terminal state.

## Guardrails

- The continuation prompt treats the objective as untrusted user data.
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

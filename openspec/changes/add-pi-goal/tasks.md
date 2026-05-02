## 1. Extension Skeleton

- [x] 1.1 Identify the Pi extension packaging location and existing extension patterns to follow.
- [x] 1.2 Create the goal continuation extension module without adding new runtime dependencies.
- [x] 1.3 Define goal state types for goal id, objective, status, token budget, tokens used, elapsed time, timestamps, useful-work state, and scheduled-continuation state.
- [x] 1.4 Add state load/reconstruction logic that reads the latest persisted goal custom entry on session load or extension initialization.

## 2. Persistence And Commands

- [x] 2.1 Implement goal state persistence through Pi custom entries that are not sent to the model.
- [x] 2.2 Register `/goal <objective>` to create an active goal with optional budget handling.
- [x] 2.3 Register `/goal status` to display objective, status, budget, tokens used, elapsed time, and remaining budget.
- [x] 2.4 Register `/goal pause`, `/goal resume`, and `/goal clear` with persisted state transitions.
- [x] 2.5 Add command tests for create, status, pause, resume, clear, and invalid command inputs.

## 3. Model Tools

- [x] 3.1 Register `get_goal` and return the current goal or an explicit no-goal response.
- [x] 3.2 Register `create_goal` and reject model-created replacement when an active or paused goal already exists.
- [x] 3.3 Register `update_goal` and allow only `status: "complete"`.
- [x] 3.4 Return final budget and elapsed-time accounting when `update_goal` completes a goal.
- [x] 3.5 Add tool tests for read, create, duplicate-create rejection, complete, and non-complete update rejection.

## 4. Continuation Loop

- [x] 4.1 Render a Codex-inspired continuation prompt that treats the objective as untrusted data and requires completion audit before `update_goal`.
- [x] 4.2 Send continuation prompts as hidden custom messages with `display: false` and `triggerTurn: true`.
- [x] 4.3 Defer continuation scheduling until after `agent_end` listeners unwind.
- [x] 4.4 Prevent duplicate scheduled continuations for the same goal and turn boundary.
- [x] 4.5 Avoid direct `agent.continue()` from assistant-tail state.
- [x] 4.6 Add a fake-provider or harness smoke test proving a hidden continuation starts after the prior run settles.

## 5. Gating And Accounting

- [x] 5.1 Suppress continuation when goal status is paused, complete, budget-limited, cleared, or absent.
- [x] 5.2 Suppress continuation while plan/read-only mode or equivalent tool-restricted planning mode is active.
- [x] 5.3 Track tool execution during active goal turns and suppress future automatic continuation after a no-tool continuation.
- [x] 5.4 Track token usage from completed turn/message usage payloads where available.
- [x] 5.5 Mark goals budget-limited when token budget is exhausted and stop automatic continuation.
- [x] 5.6 Track wall-clock elapsed time for active goal turns.
- [x] 5.7 Add tests for gating, useful-work suppression, token budget exhaustion, and elapsed-time accounting.

## 6. Context Hygiene And Documentation

- [x] 6.1 Decide whether old hidden continuation messages should remain in context or be pruned by context hooks.
- [x] 6.2 Implement context pruning only if it preserves auditability and does not break continuation behavior.
- [x] 6.3 Document user commands, model tools, limitations, and the optional future core primitive tradeoff.
- [x] 6.4 Update research notes if implementation findings change the source-level conclusion.

## 7. Verification

- [x] 7.1 Run unit tests for the extension.
- [x] 7.2 Run the smoke test proving deferred hidden custom-message continuation.
- [x] 7.3 Run typecheck/lint/format commands required by the Pi package where the extension lives.
- [x] 7.4 Re-read `openspec/changes/add-pi-goal/specs/pi-goal/spec.md` and verify every requirement has implementation/test coverage.
- [x] 7.5 Run `openspec validate add-pi-goal --strict`.

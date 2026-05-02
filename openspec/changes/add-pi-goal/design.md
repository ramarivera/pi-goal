## Context

Codex `rust-v0.128.0` implements goals as runtime-owned persisted state with model tools, user controls, budget accounting, and automatic continuation when the thread is idle. The reference implementation stores `thread_goals`, exposes `get_goal`/`create_goal`/`update_goal`, injects hidden continuation prompts, and suppresses continuation when a turn is active, user input is queued, plan mode is active, budget is exhausted, or the previous continuation did not use tools.

Pi does not currently expose a native goal continuation feature. Source research in `docs/pi-goal-context-research.md` shows Pi has the required extension-level primitives: hidden custom messages, session custom entries, `sendMessage(..., { triggerTurn: true })`, lifecycle hooks, model tool registration, command registration, and event hooks for tool execution and turns.

The implementation target is a Pi extension, not a fork of Pi core.

## Goals / Non-Goals

**Goals:**

- Provide a Codex-inspired goal continuation for Pi as an extension.
- Persist active goal state in Pi sessions.
- Let users create and control goals through `/goal` commands.
- Let the model inspect, create, and complete goals through restricted model tools.
- Continue active goals automatically with hidden custom messages after agent turns settle.
- Preserve Codex's important safety semantics: objective is untrusted data, completion requires audit, only the model completion tool may mark complete, and pause/resume/budget-limited transitions remain user/system controlled.
- Keep `.context/` repositories read-only research references.

**Non-Goals:**

- Do not fork Pi core for the first implementation.
- Do not require a new Pi primitive before an extension-level proof exists.
- Do not implement exact Codex app-server/TUI UI parity in the initial extension.
- Do not weaken Pi's queue/streaming safety by calling `agent.continue()` directly from assistant-terminal state.
- Do not treat passing tests or the existence of a goal entry as proof that a goal is complete.

## Decisions

### Decision: Implement as a Pi extension first

The feature SHALL be implemented as a Pi extension using existing extension hooks, commands, tools, and session entries.

Rationale: Pi already exposes `registerCommand`, `registerTool`, `appendEntry`, `before_agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_execution_end`, and `sendMessage` with `triggerTurn`. This is enough to validate behavior without adding core complexity.

Alternative considered: add a new core primitive for "hidden continuation turn after idle." That would produce cleaner semantics, but source research no longer supports treating it as mandatory.

### Decision: Persist goal state as custom session entries

The extension SHALL append a custom state entry whenever goal state changes. The latest entry SHALL reconstruct the active goal on session load/resume.

Rationale: Pi's custom entries persist extension state without sending it to the model. This matches the need for durable goal state while avoiding transcript pollution.

Alternative considered: encode goal state only in hidden messages. That would be brittle, harder to query, and would mix runtime state with prompt context.

### Decision: Continue through hidden custom messages

The extension SHALL render a Codex-inspired continuation prompt as a Pi custom message with `display: false`, and SHALL trigger the next turn with `{ triggerTurn: true }`.

Rationale: Pi custom messages are hidden from the UI when `display` is false but are still converted to model-visible context. This gives the extension an existing path for hidden continuation.

Alternative considered: call `agent.continue()` directly. This is unsafe for the target flow because Pi rejects direct continuation from an assistant tail unless queued messages exist, and `agent_end` listeners still run before the agent is fully idle.

### Decision: Defer continuation scheduling until after `agent_end`

The extension SHALL schedule the continuation after the current `agent_end` listener unwinds, using a minimal asynchronous deferral such as `setTimeout(..., 0)` or an equivalent scheduler.

Rationale: Pi's `agent_end` event is not the idle boundary. While `agent_end` listeners are still running, the agent can still be considered active/streaming. Deferral avoids racing `finishRun()`.

Alternative considered: call `sendMessage(..., { triggerTurn: true })` synchronously inside `agent_end`. That risks hitting streaming queue behavior rather than starting a clean continuation turn.

### Decision: Restrict model goal mutation

The model tools SHALL mirror Codex's split:

- `get_goal` returns the current goal.
- `create_goal` creates one active goal when no active goal exists.
- `update_goal` only accepts `status: "complete"`.

Rationale: This prevents the model from pausing, resuming, clearing, or budget-limiting goals by itself. Those transitions are user/system-controlled.

Alternative considered: let `update_goal` set any status. That would make the loop easier to implement but weaker than Codex's safety contract.

### Decision: Suppress no-tool continuation loops

The extension SHALL stop automatic continuation after a continuation turn that performs no tool calls, until user input or an explicit command resumes useful work.

Rationale: Codex suppresses no-tool continuations to avoid idle self-chat loops. Pi should preserve that behavior.

Alternative considered: continue after every assistant response while the goal is active. That can produce noisy loops and burn budget without evidence of progress.

## Risks / Trade-offs

- Extension-level idle detection may be less atomic than Codex core scheduling → mitigate by deferring after `agent_end`, checking local scheduled flags, and avoiding direct `agent.continue()` from assistant-tail state.
- Pi may not expose enough queue state to perfectly detect pending user input → mitigate by tracking extension-observed input events and relying on Pi's own queue semantics for streaming messages.
- Budget accounting may be approximate if event usage payloads differ by provider → mitigate by implementing accounting behind a small adapter and adding smoke tests with fixture usage.
- Hidden continuation messages may bloat model context → mitigate by using context hooks or compaction-aware filtering once the extension proves the behavior.
- Custom messages convert as user-role content, unlike Codex's developer-role continuation → mitigate by making the continuation prompt explicit that the objective is untrusted user data and by keeping completion authority in tools.
- A timer-based scheduler can be harder to reason about than core continuation state → mitigate with a single scheduled-continuation flag and tests around duplicate scheduling.

## Migration Plan

1. Add the extension in a dedicated Pi extension module.
2. Register `/goal` commands, model tools, and hidden message renderer behavior.
3. Persist and reconstruct goal state with custom entries.
4. Implement deferred continuation after `agent_end`.
5. Add unit tests for state transitions, tool restrictions, and continuation gating.
6. Add a smoke test using a fake provider/session to prove hidden continuation turns run after idle.
7. Keep optional core primitive work as a follow-up only if extension-level behavior proves too racy or too hard to maintain.

Rollback is simple for the extension path: disable or remove the extension, leaving existing session entries inert.

## Open Questions

- Does the current Pi extension context expose enough queue/pending-input information for perfect "no queued user input" gating?
- Which Pi event payload is the most reliable source for token usage across providers?
- Should old hidden continuation messages remain as audit history, or should context hooks prune them from future provider requests after their turn completes?
- Should `/goal clear` preserve a final archived state entry for auditability, or remove the goal from visible extension state entirely?

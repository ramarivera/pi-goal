## Why

OpenAI Codex `rust-v0.128.0` shipped persisted thread goals with autonomous continuation, budget accounting, model tools, and user controls. Pi does not currently have a comparable built-in goal continuation, but source research shows Pi has enough extension primitives to implement one without a core fork.

This change turns the research conclusion into an implementable specification for a Pi extension that closely follows Codex goal semantics while respecting Pi's session, custom-message, and extension APIs.

## What Changes

- Add a Pi extension-level persisted goal continuation.
- Add user commands for creating, inspecting, pausing, resuming, and clearing goals.
- Add model tools equivalent to Codex's `get_goal`, `create_goal`, and `update_goal`.
- Persist goal state in Pi session custom entries.
- Continue active goals using hidden custom messages with `display: false` and `triggerTurn: true`, deferred until after `agent_end` settles.
- Track useful-work and budget state from Pi lifecycle/tool events where available.
- Add guardrails for completion audits, no-tool continuation suppression, user-controlled pause/resume, and plan/read-only mode suppression.
- Document optional future core enhancements for cleaner parity without making them required for the extension implementation.

## Capabilities

### New Capabilities

- `pi-goal`: Defines the Pi extension behavior for persisted goals, goal continuation, model tools, user commands, state persistence, budget accounting, and safety guardrails.

### Modified Capabilities

None.

## Impact

- Affected systems: Pi coding-agent extension runtime, session persistence, custom messages, lifecycle hooks, registered commands, and registered model tools.
- Reference sources: OpenAI Codex goal implementation from `rust-v0.128.0`, Pi Mono extension/session APIs, and local research in `docs/pi-goal-context-research.md`.
- No new runtime dependency is required by the spec itself; implementation should prefer Pi's existing extension APIs.
- No direct edits to `.context/` repositories are required; they remain ignored read-only research references.

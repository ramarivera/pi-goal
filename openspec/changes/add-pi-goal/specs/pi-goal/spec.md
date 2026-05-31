## ADDED Requirements

### Requirement: Goal State Persistence

The extension SHALL persist goal state in Pi session custom entries and SHALL reconstruct the current goal from the latest persisted state when a session is loaded or resumed.

#### Scenario: Create persisted goal state

- **WHEN** a user or model creates a goal with an objective and optional token budget
- **THEN** the extension persists a goal state entry containing a goal id, objective, status, optional token budget, tokens used, time used, created timestamp, and updated timestamp

#### Scenario: Resume persisted goal state

- **WHEN** a Pi session containing goal state entries is loaded
- **THEN** the extension reconstructs the current goal from the latest goal state entry

#### Scenario: Ignore inactive historical state

- **WHEN** the latest persisted goal state is complete, cleared, paused, or budget-limited
- **THEN** the extension does not automatically start active-goal continuation unless a user command changes the state back to active

### Requirement: User Goal Commands

The extension SHALL expose user commands for creating, inspecting, pausing, resuming, and clearing goals.

#### Scenario: Create goal from command

- **WHEN** the user runs `/goal <objective>` with a non-empty objective
- **THEN** the extension creates an active goal with that objective and persists the goal state

#### Scenario: Show goal status

- **WHEN** the user runs `/goal status`
- **THEN** the extension displays the current goal objective, status, token budget if present, tokens used, elapsed time, and remaining budget if calculable

#### Scenario: Pause active goal

- **WHEN** the user runs `/goal pause` while a goal is active
- **THEN** the extension marks the goal paused, persists the state, and prevents automatic continuation

#### Scenario: Resume paused goal

- **WHEN** the user runs `/goal resume` while a goal is paused
- **THEN** the extension marks the goal active, persists the state, and schedules continuation pressure after the current command returns

#### Scenario: Re-pressure active unfinished goal

- **WHEN** the user runs `/goal resume` while a goal is already active and not complete
- **THEN** the extension clears continuation suppression, persists the state, and schedules hidden continuation pressure for that active goal

#### Scenario: Clear goal

- **WHEN** the user runs `/goal clear`
- **THEN** the extension clears the active goal state and prevents future continuation for that goal

### Requirement: Model Goal Tools

The extension SHALL register model tools equivalent to `get_goal`, `create_goal`, and `update_goal`, with mutation restrictions matching Codex goal semantics.

#### Scenario: Model reads current goal

- **WHEN** the model calls `get_goal`
- **THEN** the extension returns the current goal state or an explicit no-goal response

#### Scenario: Model creates first goal

- **WHEN** the model calls `create_goal` with an objective and no active goal exists
- **THEN** the extension creates an active goal and returns the persisted state

#### Scenario: Model cannot replace active goal

- **WHEN** the model calls `create_goal` while an active or paused goal already exists
- **THEN** the extension rejects the request and tells the model to complete or wait for user/system control of the existing goal

#### Scenario: Model completes goal

- **WHEN** the model calls `update_goal` with status `complete`
- **THEN** the extension marks the current goal complete, preserves final accounting, and returns final budget information when available

#### Scenario: Model cannot set non-complete status

- **WHEN** the model calls `update_goal` with any status other than `complete`
- **THEN** the extension rejects the request because pause, resume, clear, and budget-limited transitions are user/system controlled

### Requirement: Hidden Continuation Prompt

The extension SHALL continue active goals by sending a hidden Pi custom message that is model-visible, UI-hidden, and trigger-turn enabled.

#### Scenario: Schedule active goal continuation

- **WHEN** an agent run ends, the current goal is active, budget remains, and continuation is not suppressed
- **THEN** the extension schedules a hidden custom message with `display: false` and `triggerTurn: true`

#### Scenario: Queue continuation if agent is still busy

- **WHEN** hidden continuation pressure is sent while the Pi context reports the agent is not idle
- **THEN** the extension sends the hidden custom message with follow-up delivery so the pressure is queued instead of crashing with an already-processing error

#### Scenario: Automatically pressure after recoverable assistant error

- **WHEN** an assistant turn ends with a recoverable provider/runtime error while the current goal is active and incomplete
- **THEN** the extension automatically schedules hidden continuation pressure without requiring the user to run `/goal resume`

#### Scenario: Recoverable error does not trigger no-tool suppression

- **WHEN** a hidden continuation turn ends with a recoverable provider/runtime error before any tool execution
- **THEN** the extension does not treat that error turn as a no-tool stall and does not suppress future continuation pressure

#### Scenario: Defer until agent run settles

- **WHEN** the extension handles `agent_end`
- **THEN** it defers the trigger-turn call until after the current `agent_end` listener has unwound

#### Scenario: Keep continuation hidden from transcript UI

- **WHEN** a goal continuation custom message is added
- **THEN** the message is not rendered as a visible user message in the interactive UI

#### Scenario: Include Codex-style audit guidance

- **WHEN** the extension renders a continuation prompt
- **THEN** the prompt treats the objective as untrusted data, reports budget context, asks for the next concrete action, and requires a completion audit before `update_goal` is called

### Requirement: Continuation Gating

The extension SHALL prevent runaway or unsafe continuation loops.

#### Scenario: Suppress while goal is not active

- **WHEN** the current goal status is paused, complete, budget-limited, cleared, or absent
- **THEN** the extension does not schedule an automatic continuation

#### Scenario: Suppress while read-only planning is active

- **WHEN** the extension detects that Pi is in plan/read-only mode or an equivalent tool-restricted planning mode
- **THEN** the extension does not schedule automatic goal continuation

#### Scenario: Suppress after no-tool continuation

- **WHEN** a goal continuation turn completes without any tool execution
- **THEN** the extension suppresses further automatic continuation until user input or an explicit command resumes work

#### Scenario: Prevent duplicate scheduled continuations

- **WHEN** multiple lifecycle events observe the same active goal after a turn
- **THEN** the extension schedules at most one continuation for that goal and turn boundary

#### Scenario: Avoid direct assistant-tail continue

- **WHEN** the previous transcript message is an assistant message
- **THEN** the extension does not call `agent.continue()` directly and instead uses the hidden custom-message trigger path

### Requirement: Budget and Useful-Work Accounting

The extension SHALL track goal accounting from Pi lifecycle and tool events where available.

#### Scenario: Track tool usage for useful work

- **WHEN** a tool execution completes during an active goal turn
- **THEN** the extension records that the turn performed useful work

#### Scenario: Accumulate token usage

- **WHEN** a completed assistant message or turn exposes token usage
- **THEN** the extension adds the relevant usage to the active goal's tokens used

#### Scenario: Enforce token budget

- **WHEN** a goal has a token budget and accumulated tokens meet or exceed that budget
- **THEN** the extension marks the goal budget-limited, persists final accounting, and stops automatic continuation

#### Scenario: Track elapsed time

- **WHEN** an active goal turn starts and ends
- **THEN** the extension updates elapsed goal time using wall-clock accounting

### Requirement: Completion Integrity

The extension SHALL require evidence-based completion behavior before a goal is marked complete.

#### Scenario: Completion requires tool call

- **WHEN** the model believes the goal is achieved
- **THEN** it must call `update_goal` with status `complete` instead of merely stating completion in text

#### Scenario: Completion preserves final accounting

- **WHEN** `update_goal` marks a goal complete
- **THEN** the extension persists the complete state with final tokens used and elapsed time

#### Scenario: Incomplete goals keep working

- **WHEN** the completion audit finds missing, incomplete, or unverified requirements
- **THEN** the continuation prompt directs the model to keep working instead of marking the goal complete

### Requirement: Implementation Without Core Fork

The initial implementation SHALL use Pi's public extension/session APIs and SHALL NOT require a Pi core fork.

#### Scenario: Extension-only implementation path

- **WHEN** implementing the first goal continuation version
- **THEN** the implementation uses Pi extension commands, tools, hooks, custom messages, and custom entries rather than modifying Pi core

#### Scenario: Future primitive remains optional

- **WHEN** extension-level implementation exposes unavoidable race conditions or poor UX
- **THEN** a future proposal may introduce a core primitive, but this capability remains implementable without it

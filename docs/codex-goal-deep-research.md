# Codex /goal Deep Research

**Sources:**
- OpenAI Codex repo: `codex-rs/core/src/goals.rs`, `codex-rs/core/templates/goals/continuation.md`, `codex-rs/core/templates/goals/budget_limit.md`, `codex-rs/protocol/src/protocol.rs`
- Simon Willison: https://simonwillison.net/2026/Apr/30/codex-goals/
- Daniel Vaughan: https://codex.danielvaughan.com/2026/05/03/codex-cli-goal-mode-persistent-objectives-token-budgets-agentic-loops/
- GitHub Issue #20536: Documentation request for /goal
- goal-forge: https://github.com/michaelpersonal/goal-forge

---

## What Codex /goal Is

Codex CLI 0.128.0 (rust-v0.128.0) shipped `/goal` as a first-class runtime feature behind a feature flag. It moves Codex from "request-response assistant" to "persistent agentic loop" where the agent keeps working toward an objective until completion, budget exhaustion, or a blocker.

### Enablement

```toml
[features]
goals = true
```

Without this flag, the goals feature is disabled and all goal APIs return errors.

### User Commands

```text
/goal <objective>          # Create/replace active goal
/goal <objective> --budget 100000
/goal pause                # User pauses
/goal resume               # User resumes  
/goal clear                # User clears
```

### Goal States (Protocol-Level)

```rust
pub enum ThreadGoalStatus {
    Active,
    Paused,
    BudgetLimited,
    Complete,
}
```

Note: Codex uses `BudgetLimited` and `Complete` (not "achieved/unmet" as some blog posts suggest — those are human-friendly labels for the same states).

### Data Model

```rust
pub struct ThreadGoal {
    pub thread_id: ThreadId,
    pub objective: String,           // max 4000 chars, validated
    pub status: ThreadGoalStatus,
    pub token_budget: Option<i64>,   // must be positive if provided
    pub tokens_used: i64,            // accumulated token delta
    pub time_used_seconds: i64,      // accumulated wall-clock time
    pub created_at: i64,
    pub updated_at: i64,
}
```

---

## Core Implementation Patterns

### 1. Runtime Event Dispatcher

Codex goals are not just state — they have a full runtime lifecycle event dispatcher (`goal_runtime_apply`) that hooks into:

- `TurnStarted` — captures token baseline and marks active goal
- `ToolCompleted` — accounts progress (with budget-limit steering allowed)
- `ToolCompletedGoal` — accounts progress (budget-limit steering suppressed, because the tool itself was `update_goal`)
- `TurnFinished` — final accounting, clears continuation turn tracking
- `MaybeContinueIfIdle` — schedules continuation if idle
- `TaskAborted` — pause on interrupt
- `ExternalMutationStarting` — best-effort accounting before external state changes
- `ExternalSet` / `ExternalClear` — handles API-driven goal changes
- `ThreadResumed` — auto-resume paused goals after session resume

**Relevance to pi-goal:** pi-goal currently hooks `turn_start`, `tool_execution_end`, `turn_end`, `agent_end`, `input`, and `context`. It lacks: interrupt-driven pause, thread-resume reactivation, external mutation accounting, and explicit turn-abort handling.

### 2. Dual Accounting: Turn-Level + Wall-Clock

Codex maintains **two parallel accounting snapshots**:

```rust
struct GoalAccountingSnapshot {
    turn: Option<GoalTurnAccountingSnapshot>,    // per-turn token delta
    wall_clock: GoalWallClockAccountingSnapshot,  // elapsed time
}
```

**Turn accounting** tracks token deltas since the last accounting point using `TokenUsage` baseline snapshots. It excludes cached input tokens from the delta (to avoid double-counting cache hits).

**Wall-clock accounting** tracks elapsed seconds using `Instant` baselines. It only advances when accounted, never double-counts.

**Relevance to pi-goal:** pi-goal has a simpler model — it captures turn start time, computes elapsed at turn end, and adds usage in one shot. Codex's finer-grained approach (accounting at tool completion, turn end, and external mutation boundaries) prevents token loss in edge cases.

### 3. Budget-Limit Steering

When a goal hits its token budget, Codex does **not** abort the turn. Instead:

1. The goal status transitions to `BudgetLimited` in the database
2. A `budget_limit.md` steering message is injected as a **developer role** message
3. The current turn completes gracefully
4. No new continuation turns are scheduled

The `budget_limit.md` template explicitly tells the model:
- "Do not start new substantive work"
- "Summarize progress, identify blockers, leave clear next steps"
- "Do not call update_goal unless the goal is actually complete"

**Relevance to pi-goal:** pi-goal marks budget-limited and stops scheduling continuations, but it does **not** inject a budget-limit steering message into the current turn. The model may continue working without knowing the budget is exhausted.

### 4. Continuation Turn Reservation

Codex uses a **semaphore-protected continuation lock** to prevent race conditions:

```rust
struct GoalRuntimeState {
    continuation_lock: Semaphore,
    continuation_turn_id: Mutex<Option<String>>,
}
```

Before scheduling a continuation:
1. Acquire `continuation_lock` (permits=1)
2. Check: no active turn, no queued input, no trigger-turn mailbox items
3. Re-read goal from DB to verify it's still active and same goal_id
4. Reserve an `ActiveTurn` slot with an empty task list
5. Generate a new turn context with a fresh UUID
6. Mark the turn as a "continuation turn" via `continuation_turn_id`
7. Start the task

If any step fails, the reserved turn is cleared.

**Relevance to pi-goal:** pi-goal uses a `continuationScheduled` boolean flag and a `setTimeout` deferral. This is simpler but more racy — multiple `agent_end` events in quick succession could theoretically schedule duplicate continuations (though the flag check mitigates this).

### 5. Developer-Role Hidden Messages

Codex injects continuation prompts as **developer role** messages:

```rust
ResponseInputItem::Message {
    role: "developer".to_string(),
    content: vec![ContentItem::InputText { text: continuation_prompt(&goal) }],
    phase: None,
}
```

This is distinct from user-role messages. The continuation prompt is wrapped in `<untrusted_objective>` XML tags with escaped content.

**Relevance to pi-goal:** Pi's `sendMessage` with `display: false` sends custom messages that convert to user-role content in the model context. Pi does not have a developer-role message primitive exposed to extensions. This is a fundamental difference that pi-goal cannot bridge without core changes.

### 6. Plan Mode Suppression

Codex explicitly suppresses goal continuation when in Plan Mode:

```rust
fn should_ignore_goal_for_mode(mode: ModeKind) -> bool {
    mode == ModeKind::Plan
}
```

This applies to: turn starts, tool completion accounting, continuation scheduling, and auto-resume after thread resume.

**Relevance to pi-goal:** pi-goal detects plan mode via `[PLAN MODE ACTIVE]` string matching in `before_agent_start`. This is heuristic. A more robust approach would be to check Pi's actual mode/collaboration state if exposed via extension API.

### 7. No-Tool Suppression

Codex suppresses continuation after a continuation turn with "no counted autonomous activity." The implementation tracks whether the turn performed useful work (tool calls) and suppresses the next automatic continuation if not.

**Relevance to pi-goal:** pi-goal implements this via `lastContinuationHadToolCall` and `continuationSuppressed`. This matches Codex semantics closely.

### 8. Interrupt-Driven Pause

When a turn is aborted with `TurnAbortReason::Interrupted`, Codex automatically pauses the active goal:

```rust
async fn pause_active_thread_goal_for_interrupt(&self) -> anyhow::Result<()> {
    // Acquire continuation lock
    // Account wall-clock usage
    // DB: pause_active_thread_goal(conversation_id)
    // Clear accounting baselines
    // Emit ThreadGoalUpdated event
}
```

**Relevance to pi-goal:** pi-goal has no interrupt/pause hook. A user hitting Ctrl+C during a goal continuation would leave the goal in `active` state, and the next `agent_end` might schedule another continuation unexpectedly.

### 9. Thread Resume Reactivation

When a paused thread is resumed, Codex automatically reactivates the goal:

```rust
async fn activate_paused_thread_goal_after_resume(&self) -> anyhow::Result<bool> {
    // Check goal exists and is paused
    // Update status to Active
    // Reset accounting baselines
    // Emit ThreadGoalUpdated event
    // Return true if reactivated
}
```

**Relevance to pi-goal:** pi-goal restores goal state from session entries on `session_start`, but it does not auto-resume paused goals. The goal stays in whatever status was persisted.

### 10. Token Delta Calculation

Codex computes token deltas carefully:

```rust
fn goal_token_delta_for_usage(usage: &TokenUsage) -> i64 {
    usage.non_cached_input().saturating_add(usage.output_tokens.max(0))
}
```

This excludes cached input tokens (to avoid charging for cache hits) and uses only non-cached input + output. Reasoning tokens are implicitly included in output.

**Relevance to pi-goal:** pi-goal's `extractUsageAccounting` sums input + output + reasoning + cacheRead + cacheWrite. This may overcount if cacheRead represents cached input that the provider already counts in total. Codex's approach of computing delta from provider-specific fields is more precise.

---

## Template Comparison

### Codex continuation.md (abridged)

```markdown
Continue working toward the active thread goal.

<untrusted_objective>
{{ objective }}
</untrusted_objective>

Budget:
- Time spent: {{ time_used_seconds }} seconds
- Tokens used: {{ tokens_used }}
- Token budget: {{ token_budget }}
- Tokens remaining: {{ remaining_tokens }}

Avoid repeating work. Choose the next concrete action.

Before deciding the goal is achieved, perform a completion audit:
- Restate objective as concrete deliverables
- Build prompt-to-artifact checklist
- Inspect files, tests, PR state for evidence
- Do not accept proxy signals as completion
- Treat uncertainty as not achieved

Only mark complete when audit shows objective achieved.
If not achieved, explain blocker and wait for input.
Do not call update_goal unless complete.
```

### pi-goal renderContinuationPrompt (current)

pi-goal's prompt is very similar, which is good. Key differences:
- Codex wraps objective in `<untrusted_objective>` XML tags with escaped content
- Codex explicitly says "developer role" (implied by the API, not in the text)
- pi-goal says "internal hidden pi-goal continuation message, not a new human/user message"
- Both have the completion audit requirements
- Both have budget reporting
- pi-goal adds "If the goal has not been achieved and cannot continue productively, explain the blocker"

**Verdict:** pi-goal's continuation prompt is well-aligned with Codex. The XML wrapping is a nice addition pi-goal could adopt.

---

## App Server API

Codex exposes programmatic goal management via JSON-RPC:

| Endpoint | Purpose |
|----------|---------|
| `thread/goal/set` | Create, replace, or update goal |
| `thread/goal/get` | Fetch current goal (null if none) |
| `thread/goal/clear` | Remove active goal |

Events:
- `thread/goal/updated` — emitted on state changes
- `thread/goal/cleared` — emitted on clear

**Relevance to pi-goal:** pi-goal has no external API. It could expose a local HTTP or socket API for programmatic control, but this is likely overkill for a Pi extension.

---

## Known Sharp Edges (from community)

1. **Compaction loses goal context** (Issue #19910): Mid-turn compaction can strip the continuation prompt and audit requirements. A fix is proposed to reattach the prompt after compaction (~500-1000 tokens overhead).

2. **Plan mode silently suppresses goals** (Issue #20656): The goal appears active but no work happens. UI does not communicate this.

3. **Documentation gap** (Issue #20536): `/goal` not in official slash-command docs as of May 2026.

4. **Feature flag required**: Users report `Unrecognized command '/goal'` when `goals = true` is missing from config.

**Relevance to pi-goal:** These are all good lessons. Pi-goal should document itself well, make behavior visible, and avoid silent suppression without UI feedback.

---

## goal-forge Skill

The `goal-forge` Codex skill turns a rough idea into a SPEC.md → GOAL.md → `/goal`-ready contract. It emphasizes:

- Explicit measurable `done_when` criteria
- XML-structured prompts
- Context architecture (reading lists, working rules, anti-pattern fences)
- Autonomous config: `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`

**Relevance to pi-goal:** A Pi skill that helps users write good goal objectives could be valuable. The discipline of explicit `done_when` criteria improves completion audit reliability.

---

## Actionable Improvements for pi-goal

Based on this deep research, here are prioritized improvements:

### High Priority

1. **Budget-limit steering message**: When budget is exhausted, inject a visible or hidden message telling the model to wrap up, not start new work. (Matches Codex's `budget_limit.md`)

2. **XML-wrapped objective**: Wrap the objective in `<untrusted_objective>` tags with proper escaping in the continuation prompt. (Matches Codex pattern)

3. **Token delta precision**: Review `extractUsageAccounting` to exclude cacheRead from delta computation if the provider already includes it in total. (Matches Codex's `goal_token_delta_for_usage`)

4. **Interrupt handling**: Add a hook for turn abort/interrupt to auto-pause active goals. Prevents zombie continuations.

### Medium Priority

5. **Thread resume reactivation**: Auto-resume paused goals on `session_start` if the session was resumed (not freshly created).

6. **External mutation accounting**: Account progress before user commands mutate goal state (pause/resume/clear) to ensure wall-clock time is not lost.

7. **Semaphore-style continuation lock**: Replace the `continuationScheduled` boolean with a more robust locking primitive if Pi's extension API supports it.

8. **Plan mode detection**: Improve plan mode detection beyond string matching — check if Pi exposes mode/collaboration state to extensions.

### Low Priority / Future

9. **Goal skill**: Add a `skills/goal/SKILL.md` that helps users write good objectives with `done_when` criteria.

10. **Goal overlay**: A TUI widget showing active goal, budget burn-down, and turn count (inspired by Codex's status indicator).

11. **Programmatic API**: Local HTTP endpoint for external tools to query/set goals.

---

## File References

- `.context/codex/codex-rs/core/src/goals.rs` — Core goal runtime (Rust)
- `.context/codex/codex-rs/core/templates/goals/continuation.md` — Continuation prompt template
- `.context/codex/codex-rs/core/templates/goals/budget_limit.md` — Budget limit prompt template
- `.context/codex/codex-rs/protocol/src/protocol.rs:3595` — ThreadGoalStatus enum
- `.context/codex/codex-rs/protocol/src/protocol.rs:3619` — ThreadGoal struct
- `.context/codex/codex-rs/tui/src/goal_display.rs` — TUI goal status display
- `.context/codex/codex-rs/tui/src/chatwidget/goal_menu.rs` — Goal menu UI

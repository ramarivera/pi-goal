# pi-btw Context Research

**Repo:** https://github.com/dbachelder/pi-btw  
**Commit:** `aff4c16` (main)  
**Date:** 2026-05-05

## What pi-btw Does

pi-btw is a Pi extension that adds `/btw` — a parallel side-conversation channel that runs as a real Pi sub-session with full coding-tool access, even while the main agent is busy. It demonstrates advanced Pi extension patterns that pi-goal can learn from.

## Key Patterns Relevant to pi-goal

### 1. Sub-Session Management

pi-btw creates actual `AgentSession` instances via `createAgentSession()` rather than just sending messages:

```ts
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  model: settings.model,
  modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
  thinkingLevel: settings.thinkingLevel,
  tools: codingTools,
  resourceLoader: createBtwResourceLoader(ctx),
});
```

**Relevance to pi-goal:** Currently pi-goal uses hidden custom messages for continuation. A future enhancement could spin up a constrained sub-session for goal-audit work without polluting the main thread context.

### 2. Context Filtering & Session Seeding

pi-btw filters main-session context when seeding the BTW sub-session:

```ts
messages.push(
  ...(buildSessionContext(ctx.sessionManager.getEntries(), ...).messages.filter(
    (message) => !isVisibleBtwMessage(message)
  ))
);
```

**Relevance to pi-goal:** pi-goal already prunes stale `pi-goal-continuation` messages via the `context` hook. pi-btw shows a more sophisticated pattern: filtering by message role/customType during session construction. pi-goal could adopt `buildSessionContext` for more robust context hygiene.

### 3. Hidden Thread State Persistence

pi-btw persists exchanges as hidden custom entries:

```ts
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override";
```

**Relevance to pi-goal:** pi-goal already uses `pi-goal-state` custom entries. pi-btw shows the value of multiple entry types for different concerns (state, resets, overrides). pi-goal could split into `pi-goal-state`, `pi-goal-reset`, `pi-goal-budget-exceeded` for cleaner audit trails.

### 4. TUI Overlay Architecture

pi-btw builds a full modal overlay using `@mariozechner/pi-tui` components:
- `BtwOverlayComponent` extends `Container implements Focusable`
- Custom keybindings (`Alt+/`, `Ctrl+Alt+W`, `Esc`)
- Scrollable transcript with `PgUp`/`PgDown`
- Live status updates during streaming

**Relevance to pi-goal:** pi-goal currently has no UI beyond `ctx.ui.notify()`. A future enhancement could add a `/goal:overlay` or similar to show live goal progress, budget burn-down, and turn history in a TUI panel.

### 5. Model & Thinking Overrides

pi-btw supports BTW-only model overrides independent of the main thread:

```ts
async function resolveBtwModel(ctx): Promise<ResolvedBtwModel> {
  if (btwModelOverride) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(btwModelOverride);
    if (auth.ok && auth.apiKey) {
      return { model: btwModelOverride, source: "override" };
    }
    // fallback to main model with warning
  }
  return { model: ctx.model, source: "main" };
}
```

**Relevance to pi-goal:** Goal continuation could benefit from running audit/completion checks on a cheaper model while keeping the main thread on the primary model. Not critical for v1 but a powerful future knob.

### 6. Thread Continuation Markers

pi-btw uses explicit continuation markers to separate inherited context from side-thread history:

```ts
const BTW_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
const BTW_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";
```

**Relevance to pi-goal:** pi-goal's continuation prompt could adopt a similar explicit boundary marker to make it clearer to the model where the hidden continuation begins/ends, reducing confusion in long threads.

### 7. Event Subscription & Cleanup

pi-btw carefully manages event subscriptions with cleanup:

```ts
function removeBtwSessionSubscription(sessionRuntime: BtwSessionRuntime, unsubscribe: () => void): void {
  if (!sessionRuntime.subscriptions.delete(unsubscribe)) return;
  try { unsubscribe(); } catch { /* ignore */ }
}
```

**Relevance to pi-goal:** pi-goal registers hooks via `pi.on()` but doesn't explicitly unsubscribe. While Pi's extension lifecycle may handle this, pi-btw shows defensive patterns for session disposal and abort handling.

### 8. Transcript State Machine

pi-btw maintains a sophisticated transcript state machine with turn boundaries, streaming flags, and tool-call tracking. This enables the live overlay to show streaming progress accurately.

**Relevance to pi-goal:** If pi-goal adds a TUI overlay, it will need similar transcript tracking. For now, pi-goal's simpler state (turn count, continuation count, tool-use flag) is sufficient.

## Testing Patterns

pi-btw uses vitest with runtime tests. pi-goal uses Node's built-in test runner with a fake Pi fixture. Both approaches are valid; pi-goal's fake Pi pattern is lighter for unit-testing state transitions.

## File Structure Comparison

| Aspect | pi-goal | pi-btw |
|--------|---------|--------|
| Entrypoint | `src/index.ts` | `extensions/btw.ts` |
| Package type | npm publishable | npm publishable |
| TUI overlay | None | Full modal overlay |
| Sub-sessions | None | Real `AgentSession` |
| Skills included | No | Yes (`skills/btw/SKILL.md`) |
| Tests | Node built-in `node:test` | vitest |
| CI | None in repo | GitHub Actions CI + publish |

## Actionable Improvements for pi-goal

1. **Context hygiene:** Adopt `buildSessionContext` filtering pattern for more robust stale-continuation pruning.
2. **Entry type splitting:** Split single `pi-goal-state` into typed entries (state, reset, budget-limit) for cleaner audit.
3. **Explicit continuation markers:** Add user/assistant boundary markers around continuation prompts.
4. **Defensive subscription cleanup:** Add explicit unsubscribe/abort handling if Pi extension API supports it.
5. **Skill inclusion:** Add a `skills/goal/SKILL.md` for discoverability (pi-btw includes one).
6. **TUI overlay (future):** Consider a live goal status overlay using pi-tui components.
7. **Model override (future):** Consider goal-audit on a cheaper model.
8. **CI/CD:** Add GitHub Actions workflow for test + publish (pi-btw has this).

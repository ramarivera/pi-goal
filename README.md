# @ramarivera/pi-goal

Pi extension that adds Codex-style persisted goals, `/goal` commands, model goal tools, and hidden continuation pressure.

## Install

After the package is published:

```sh
pi package install @ramarivera/pi-goal
```

The publishable extension source is:

```text
src/index.ts
```

For local development, Pi discovers the project-local shim from:

```text
.pi/extensions/pi-goal/index.ts
```

That shim imports the real source entrypoint and is intentionally not part of the package payload.
To avoid collisions when the published package is also installed globally, the project-local shim registers `/local-goal` and `local_get_goal` / `local_create_goal` / `local_update_goal`.

## Commands

```text
/goal <objective>
/goal <objective> --budget 10000
/goal status
/goal pause
/goal resume
/goal clear
```

Creating a goal also submits the objective as the next user message after the goal state is persisted, so the agent starts working on it immediately.

Recoverable provider/runtime errors automatically re-apply hidden continuation pressure while a goal is active and incomplete, so long-running goals can keep moving without manual intervention.

`/goal resume` can also be used as a manual pressure button when an active goal stalls: it clears continuation suppression and schedules the hidden continuation again if the goal is still active and incomplete.

In interactive Pi sessions, `/goal status` opens a compact overlay with the objective, lifecycle status, usage, budget, elapsed time, and model breakdown. In non-interactive modes it falls back to the plain text status notification.

When developing from this repository with the global package installed, use the local command names:

```text
/local-goal <objective>
/local-goal <objective> --budget 10000
/local-goal status
/local-goal pause
/local-goal resume
/local-goal clear
```

See `docs/pi-goal-extension.md` for behavior and test details.

## Skill

This package also ships a `goal` skill under `skills/goal/SKILL.md` that helps Pi recognize when a persisted-goal workflow is appropriate and guides users toward effective objective writing, budget control, and completion auditing.

The skill covers:
- When to use `/goal` vs regular chat
- How to write specific, verifiable objectives
- Understanding the completion audit
- Budget guidance and lifecycle behavior
- Examples: migration campaigns, test coverage, lint sweeps

## Tracing

`pi-goal` writes structured Pino JSON logs for goal state changes, `/goal` commands, model tools, lifecycle hooks, hidden continuation scheduling, context pruning, token accounting, and suppression decisions.

Default log file:

```text
~/.pi/logs/pi-goal.log
```

Environment variables:

```text
PI_GOAL_LOG_LEVEL=debug
PI_GOAL_LOG_FILE=/tmp/pi-goal.log
PI_GOAL_LOG_FILE=stdout
PI_GOAL_LOG=0
PI_GOAL_CONTINUATION_DELAY_MS=250
```

Logs intentionally include goal ids, statuses, counters, usage, and scheduling reasons, but not full continuation prompts or objective text.

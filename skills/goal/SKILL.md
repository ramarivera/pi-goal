---
name: goal
description: Helps you use the /goal persisted-goal workflow effectively. Use when you want the agent to pursue a multi-step objective autonomously across turns, with budget control and completion verification.
---

# Goal

Use this skill when you want the agent to keep working toward an objective across multiple turns without you re-prompting after each step.

## When to use /goal

Prefer the `/goal` workflow when:

- The task spans multiple files, tests, or verification steps
- You want the agent to self-continue after each turn until done
- You need a concrete completion audit before the agent declares victory
- You want budget control over long-running agentic work

Do **not** use `/goal` for:

- Single-turn questions or quick lookups (regular chat is faster)
- Exploratory brainstorming where the end state is unclear
- Tasks where you want to review every tool call before it runs

## Commands

```text
/goal <objective>                    # Create an active goal
/goal <objective> --budget 100000    # Create with token budget
/goal status                         # Show current goal, usage, and budget
/goal pause                          # Pause continuation (current turn finishes)
/goal resume                         # Resume automatic continuation
/goal clear                          # Clear the goal and stop continuation
```

## Writing a good objective

A good objective is specific enough that the agent can verify completion without guessing.

**Weak:** "Fix the auth code"

**Strong:** "Refactor all JWT verification in src/auth/ to use the new jose library. Update unit tests and integration tests. Run the test suite and confirm zero failures. Stop if any test fails."

Include in your objective:

- **Scope:** Which files, modules, or directories
- **Success criteria:** What "done" looks like (tests pass, types check, linter clean)
- **Constraints:** Budget limits, stop conditions, things to avoid
- **Verification:** How to confirm the work is correct

## The completion audit

Before the agent marks a goal complete, it performs an audit:

1. Restate the objective as concrete deliverables
2. Map every requirement to actual evidence (files, test output, PR state)
3. Verify coverage — passing tests alone do not prove completion if the objective has requirements beyond test coverage
4. Identify any missing, incomplete, or unverified items
5. Only call `update_goal` with `status: "complete"` when the audit passes

**You can help** by making your objective explicit about what evidence counts as done.

## Budget guidance

Token budgets are the primary cost-control lever. Rough estimates:

- **Small goal** (single module, ~20 files): 50,000–150,000 tokens
- **Medium goal** (cross-module, ~50 files): 150,000–500,000 tokens
- **Large goal** (codebase-wide, 100+ files): 500,000–2,000,000+ tokens

Set your budget conservatively. You can always `/goal resume` to continue where you left off — goal state and progress survive across sessions.

## Lifecycle

```
User creates goal -> Agent works -> Turn ends -> Agent continues -> ... -> Audit passes -> Goal complete
     ^                    |            |              |
     |                    v            v              v
  /goal pause      Budget limit   No-tool turn    User input
  /goal resume     -> stops       -> suppressed   -> resets suppression
  /goal clear      gracefully
```

- **Paused** goals do not auto-continue
- **Budget-limited** goals stop scheduling new turns gracefully (current turn wraps up)
- **No-tool turns** suppress the next automatic continuation until you send input or resume
- **User input** resets continuation suppression and lets the agent continue

## Recommendations

- Prefer `/goal` over manual re-prompting for any task that takes more than 2–3 turns
- Use `--budget` on your first `/goal` in a new codebase to learn the burn rate
- Use `/goal status` mid-flight to check progress and remaining budget
- Use `/goal pause` before switching to a side conversation or unrelated task
- If the agent seems stuck in a loop, use `/goal pause`, assess, then `/goal resume` or `/goal clear`

## Examples

### Migration campaign

```text
/goal Migrate all 47 React class components in src/components/ to functional components with hooks. Run the existing test suite after each file. Stop if any test fails. --budget 300000
```

### Test coverage gap

```text
/goal Increase test coverage for src/payments/ from 43% to 80%. Write integration tests, not unit tests with mocked dependencies. Run coverage after each new test file.
```

### Lint fix sweep

```text
/goal Fix all 312 ESLint errors reported by `npm run lint`. Fix in batches of 10 files. Run lint after each batch to confirm the count decreases.
```

### Pausing for a side question

```text
/goal pause
/btw what file defines this route?
/goal resume
```

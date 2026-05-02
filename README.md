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

## Commands

```text
/goal <objective>
/goal <objective> --budget 10000
/goal status
/goal pause
/goal resume
/goal clear
```

See `docs/pi-goal-extension.md` for behavior and test details.

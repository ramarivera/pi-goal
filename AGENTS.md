# Agent Instructions

## Project Context

This repository is a research workspace for designing a Codex-style persisted goal continuation for the Pi coding agent.

- OpenSpec is enabled in `openspec/`; treat approved specs as the primary implementation guide.
- Context repositories live under ignored `.context/` and must stay untracked.
- `btca.config.jsonc` is the committed canonical list of context resources.
- Research notes may be committed under `docs/`.

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks with `bd hooks install` for auto-injection.

Quick reference:

```bash
bd ready
bd create "Title" --type task --priority 2
bd show <id>
bd close <id>
bd dolt push
```


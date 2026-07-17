# pi-plan

Plan mode for [pi](https://pi.dev) — read-only codebase exploration with interactive question-and-answer flow.

## Features

- **`/plan`** — Toggle plan mode on/off (`Ctrl+Shift+P` also works)
- **`/plan-model`** — Set which model to use during plan mode (interactive picker or `provider/modelId`)
- **Automatic model switching** — Switches to the plan model when entering plan mode and restores the code model when leaving
- **Read-only enforcement** — Blocks `edit`, `write`, and mutating `bash` while active
- **One-at-a-time questions** — When the agent needs clarification, it asks one question at a time with numbered options you can copy-paste
- **Iterative refinement** — Your answers are fed back to the agent so the plan can be refined until all questions are resolved
- **Persistent state** — Model selections and plan mode state survive `/reload`, `/resume`, and fork

## Install

```bash
pi install git:github.com/EugeneKallis/pi-plan
```

## Usage

1. Run `/plan` to enter plan mode
2. The agent explores the codebase (read-only) and creates a plan
3. If the agent needs clarification, it asks one question at a time with numbered options:

   ```
   **Question:** Should we use Redis or an in-memory Map for caching?

   1. Redis — persistent across restarts, production-ready
   2. In-memory Map — simpler, no dependency
   3. Type your own
   ```

4. Type the number or your own answer → agent moves to the next question (if any)
5. Run `/plan` again to exit plan mode and execute the approved plan

### Model switching

Plan mode supports using a different model for planning vs. coding. This is
useful when you want a cheaper or faster model during the read-only exploration
phase, and your full reasoning model for executing the plan.

```bash
# Pick a model from an interactive list
/plan-model

# Or specify directly
/plan-model anthropic/claude-sonnet-4-20250514

# Clear the preference (will use current model for both)
/plan-model clear
```

When plan mode is on, the status bar shows the active plan model:
`⊕ plan [claude-sonnet-4-20250514]`

If you change the model manually while planning (via `/model` or `Ctrl+P`),
the plan-mode preference updates to match your latest choice.

### How questions work

The model asks one question at a time and waits for your answer before moving on. Each question has numbered options you can copy-paste by typing the number or describing your own choice. No TUI widgets — just clean text output you can interact with directly.

## Development

```bash
git clone git@github.com:EugeneKallis/pi-plan
cd pi-plan
# Test locally
pi -e ./extensions/plan-mode.ts
```

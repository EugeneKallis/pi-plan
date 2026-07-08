# pi-plan

Plan mode for [pi](https://pi.dev) — read-only codebase exploration with an interactive open-questions TUI resolver.

## Features

- **`/plan`** — Toggle plan mode on/off (`Ctrl+Shift+P` also works)
- **Read-only enforcement** — Blocks `edit`, `write`, and `bash` while active
- **Open questions TUI** — When the agent lists open questions in the plan, the extension presents them one at a time with selectable suggested answers and a "Type something..." custom input option
- **Iterative refinement** — Your answers are fed back to the agent so the plan can be refined until all questions are resolved
- **Persistent state** — Survives `/reload`, `/resume`, and fork

## Install

```bash
pi install git:github.com/username/pi-plan
```

Or from npm (when published):

```bash
pi install npm:pi-plan
```

## Usage

1. Run `/plan` to enter plan mode
2. The agent explores the codebase (read-only) and creates a plan
3. If the agent has open questions, a TUI appears with suggested answers:

```
┌──────────────────────────────────────────────┐
│  Question 1/2                                 │
│  Should we use Redis or in-memory cache?      │
│                                                │
│  > 1. Redis (for persistence across restarts)  │
│    2. In-memory cache (simpler, no dep)        │
│    3. ✏️  Type something...                    │
│                                                │
│  ↑↓ navigate • Enter to select • Esc to cancel │
└──────────────────────────────────────────────┘
```

4. Answer all questions → agent refines the plan with your answers
5. Run `/plan` again to exit plan mode and execute the approved plan

## Development

```bash
git clone https://github.com/username/pi-plan
cd pi-plan
# Test locally
pi -e ./extensions/plan-mode.ts
```

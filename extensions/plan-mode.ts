/**
 * Plan Mode — read-only planning toggle for pi.
 *
 * `/plan`        toggle plan mode on/off
 * `Ctrl+Shift+P` same toggle (shortcut)
 *
 * While plan mode is ACTIVE:
 *   - `before_agent_start` appends a planning protocol to the system prompt:
 *     research deeply, produce a STEP-BY-STEP plan (goal → steps → files
 *     touched → risks), and make NO changes.
 *   - `tool_call` blocks `edit` and `write` so the agent cannot modify files.
 *     `read` and `bash` (for ls/grep/find/cat) stay available for exploration.
 *   - A status badge ("⊕ plan") is shown and a notify is emitted on toggle.
 *
 * While plan mode is INACTIVE: no injection, no blocking, badge cleared.
 *
 * State is persisted per-session via `pi.appendEntry("plan-state", { active })`
 * so it survives `/reload`, `/resume`, and fork; a brand-new session starts OFF.
 *
 * `/plan` is deliberately a pure toggle ("enable or disable and only"). The plan
 * itself is the agent's chat output and stays in context across the toggle so
 * the same agent can execute it once mode is turned off. To persist the plan to
 * a file that survives compaction, add a `save_plan` tool later.
 *
 * Placement: `~/.pi/agent/extensions/plan-mode.ts` (global auto-discovery —
 * loads for every agent/project without per-cwd wiring).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const STATE_TYPE = "plan-state";
const STATUS_KEY = "plan-mode";
const BLOCKED_TOOLS = new Set(["edit", "write"]);
const BLOCKED_BASH_PATTERNS = [
	/\brm\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/,
	/\bnpm\b/, /\bpnpm\b/, /\byarn\b/, /\bpip\b/, /\bbrew\b/,
	/\bgit\s+(commit|push|pull|merge|rebase|reset)\b/
];

const PLAN_SYSTEM_PROMPT = [
	"",
	"# PLAN MODE — ACTIVE",
	"",
	"You are currently in PLAN MODE. Your sole objective is to build a clear,",
	"executable plan that you (or another agent) can run with afterward.",
	"",
	"Hard constraints while plan mode is on:",
	"- Do NOT modify files, run package managers, or execute mutating commands.",
	"  `edit` and `write` are blocked. `read` is available for reading files.",
	"  `bash` is available for read-only commands like `ls`, `find`, `grep`, `cat`.",
	"  Do NOT run: rm, mv, cp, mkdir, npm, pnpm, yarn, pip, brew, git commit/push.",
	"- If you genuinely cannot make progress without running something mutating,",
	"  note it as an open question and ask the user instead of working around the block.",
	"",
	"Do this:",
	"1. Read the relevant files IN FULL (no offset/limit skipping) so you don't",
	"   miss details. Grep for related code and prior art.",
	"2. State the goal in one line, then lay out numbered steps. For each step:",
	"   what to change, why, and which function/file is touched.",
	"3. Call out risks, edge cases, and dependencies (other modules, tests,",
	"   migrations) that the change implies.",
	"4. List every file that will be modified or created.",
	"",
	"Keep the plan tight and concrete — it is the handoff artifact for execution.",
	"When the user runs `/plan` again to turn plan mode OFF, you may proceed to",
	"execute the plan above, step by step.",
	"# /PLAN MODE",
].join("\n");

interface PlanState {
	active: boolean;
}

export default function (pi: ExtensionAPI) {
	// In-memory mode flag. Single source of truth at runtime; persisted via
	// appendEntry so reload/resume/fork restore it.
	let active = false;

	function setStatus(ctx: ExtensionContext) {
		if (active) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "⊕ plan"));
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	function setMode(next: boolean, ctx: ExtensionContext) {
		if (next === active) return;
		active = next;
		pi.appendEntry(STATE_TYPE, { active } satisfies PlanState);
		setStatus(ctx);
	}

	async function toggle(ctx: ExtensionContext) {
		try {
			setMode(!active, ctx);
		} catch (err) {
			console.error("[plan-mode] Failed to toggle:", err);
		}
	}

	// -- Toggle command -------------------------------------------------------
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only planning) on/off",
		handler: async (_args, ctx) => {
			await toggle(ctx);
		},
	});

	// -- Toggle shortcut -----------------------------------------------------
	pi.registerShortcut(Key.ctrlShift("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			await toggle(ctx);
		},
	});

	// -- System-prompt injection ---------------------------------------------
	pi.on("before_agent_start", async (event) => {
		if (!active) return;
		return { systemPrompt: `${event.systemPrompt}${PLAN_SYSTEM_PROMPT}` };
	});

	// -- Read-only enforcement ------------------------------------------------
	pi.on("tool_call", async (event) => {
		if (!active) return;
		if (BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode is active — \`${event.toolName}\` is blocked. Use \`read\` to read files, and \`bash\` for read-only commands (ls, grep, find). Run /plan to turn plan mode OFF to execute changes.`,
			};
		}
		// Block bash commands that mutate the filesystem or run package managers
		if (event.toolName === "bash") {
			const cmd = (event.args as Record<string, unknown>)?.command;
			if (typeof cmd === "string" && BLOCKED_BASH_PATTERNS.some(p => p.test(cmd))) {
				return {
					block: true,
					reason: `Plan mode is active — mutating command blocked: \`${cmd.slice(0, 80)}\`. Run /plan to turn plan mode OFF to execute changes.`,
				};
			}
		}
	});

	// -- Restore persisted state on startup/reload/resume/fork ----------------
	pi.on("session_start", async (_event, ctx) => {
		try {
			active = false; // default for a fresh session
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i] as { type: string; customType?: string; data?: unknown };
				if (e.type === "custom" && e.customType === STATE_TYPE) {
					const data = e.data as PlanState | undefined;
					if (data && typeof data.active === "boolean") {
						active = data.active;
					}
					break;
				}
			}
		} catch (err) {
			console.error("[plan-mode] Failed to restore state:", err);
			active = false;
		}
		setStatus(ctx);
	});

	// -- Keep persisted state fresh on each turn -----------------------------
	let lastPersisted = false;
	pi.on("turn_start", async () => {
		if (active !== lastPersisted) {
			pi.appendEntry(STATE_TYPE, { active } satisfies PlanState);
			lastPersisted = active;
		}
	});
}

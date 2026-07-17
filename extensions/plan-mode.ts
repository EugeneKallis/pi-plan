/**
 * Plan Mode — read-only planning toggle for pi.
 *
 * `/plan`              toggle plan mode on/off
 * `/plan-model`        set which model to use during plan mode
 * `Ctrl+Shift+P`       same toggle (shortcut)
 *
 * While plan mode is ACTIVE:
 *   - `before_agent_start` appends a planning protocol to the system prompt:
 *     research deeply, produce a STEP-BY-STEP plan (goal → steps → files
 *     touched → risks), and make NO changes.
 *   - `tool_call` blocks `edit` and `write` so the agent cannot modify files.
 *     `read` and `bash` (for ls/grep/find/cat) stay available for exploration.
 *   - The model switches to the configured plan model (if set).
 *   - A status badge ("⊕ plan") is shown.
 *
 * While plan mode is INACTIVE:
 *   - No injection, no blocking, badge cleared.
 *   - The model switches back to the code model that was active before planning.
 *
 * State is persisted per-session via `pi.appendEntry("plan-state", { ... })`
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

/** Serialisable reference to a Model (provider + id). */
interface ModelSlot {
	provider: string;
	id: string;
}

interface PlanState {
	active: boolean;
	codeModel?: ModelSlot;
	planModel?: ModelSlot;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function modelSlotFromModel(ctx: ExtensionContext): ModelSlot | null {
	if (!ctx.model) return null;
	return { provider: ctx.model.provider, id: ctx.model.id };
}

function modelSlotKey(slot: ModelSlot | null): string | null {
	return slot ? `${slot.provider}/${slot.id}` : null;
}

async function switchToModelSlot(slot: ModelSlot | null, ctx: ExtensionContext): Promise<boolean> {
	if (!slot) return false;
	const model = ctx.modelRegistry.find(slot.provider, slot.id);
	if (!model) {
		ctx.ui.notify(
			`[plan-mode] Model ${slot.provider}/${slot.id} no longer available`,
			"warning",
		);
		return false;
	}
	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(
			`[plan-mode] No API key for ${slot.provider}/${slot.id} — staying on current model`,
			"error",
		);
	}
	return ok;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// In-memory state. Single source of truth at runtime; persisted via
	// appendEntry so reload/resume/fork restore it.
	let active = false;
	let codeModel: ModelSlot | null = null;   // model to restore when leaving plan mode
	let planModel: ModelSlot | null = null;   // model to use during plan mode

	function setStatus(ctx: ExtensionContext) {
		if (active) {
			const planTag = planModel ? ` [${planModel.id}]` : "";
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `⊕ plan${planTag}`));
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	function persistState() {
		pi.appendEntry(STATE_TYPE, {
			active,
			...(codeModel ? { codeModel } : {}),
			...(planModel ? { planModel } : {}),
		} satisfies PlanState);
	}

	function setMode(next: boolean, ctx: ExtensionContext) {
		if (next === active) return;
		active = next;
		persistState();
		setStatus(ctx);
	}

	function formatModelId(slot: ModelSlot | null): string {
		return slot ? `${slot.provider}/${slot.id}` : "<none>";
	}

	async function toggle(ctx: ExtensionContext) {
		try {
			if (active) {
				// ── Leaving plan mode ──────────────────────────────────────
				// Snapshot whatever model is active as the plan-model preference
				// (user may have changed it during planning).
				const current = modelSlotFromModel(ctx);
				if (current) {
					planModel = current;
				}
				// Restore the code model
				if (codeModel) {
					const restored = await switchToModelSlot(codeModel, ctx);
					if (restored) {
						ctx.ui.notify(
							`[plan-mode] Switched back to ${formatModelId(codeModel)}`,
							"info",
						);
					}
				}
			} else {
				// ── Entering plan mode ─────────────────────────────────────
				// Save current model as the code model to restore later
				codeModel = modelSlotFromModel(ctx);
				// Switch to plan model if configured
				if (planModel) {
					const switched = await switchToModelSlot(planModel, ctx);
					if (switched) {
						ctx.ui.notify(
							`[plan-mode] Switched to ${formatModelId(planModel)}`,
							"info",
						);
					}
				}
			}
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

	// -- Configure plan model ------------------------------------------------
	pi.registerCommand("plan-model", {
		description: "Set which model to use during plan mode. Usage: /plan-model [provider/model | clear]",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();

			// /plan-model clear → clear the preference
			if (trimmed === "clear") {
				planModel = null;
				persistState();
				setStatus(ctx);
				ctx.ui.notify("[plan-mode] Plan model cleared (will use current model)", "info");
				return;
			}

			// /plan-model provider/id → set directly
			if (trimmed && !trimmed.startsWith("/")) {
				const slashIdx = trimmed.indexOf("/");
				if (slashIdx === -1 || slashIdx === 0 || slashIdx === trimmed.length - 1) {
					ctx.ui.notify(
						"[plan-mode] Usage: /plan-model <provider/modelId> or /plan-model clear",
						"warning",
					);
					return;
				}
				const provider = trimmed.slice(0, slashIdx);
				const id = trimmed.slice(slashIdx + 1);
				const model = ctx.modelRegistry.find(provider, id);
				if (!model) {
					ctx.ui.notify(
						`[plan-mode] Model "${trimmed}" not found. Use /plan-model with no args to pick from available models.`,
						"warning",
					);
					return;
				}
				planModel = { provider, id };
				persistState();
				setStatus(ctx);
				ctx.ui.notify(`[plan-mode] Plan model set to ${formatModelId(planModel)}`, "info");
				return;
			}

			// /plan-model (no args) → show a picker of available models
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("[plan-mode] No models available. Configure one in settings or /login.", "warning");
				return;
			}

			// Build a user-friendly list sorted by provider then id
			available.sort((a, b) => {
				if (a.provider < b.provider) return -1;
				if (a.provider > b.provider) return 1;
				return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			});

			const labels = available.map(
				(m) => `${m.provider}/${m.id}`,
			);

			const choice = await ctx.ui.select("Pick a model for plan mode:", labels, {
				placeholder: "Filter models...",
			});

			if (!choice) {
				ctx.ui.notify("[plan-mode] No model selected — plan model unchanged.", "info");
				return;
			}

			const slashIdx = choice.indexOf("/");
			const chosenProvider = choice.slice(0, slashIdx);
			const chosenId = choice.slice(slashIdx + 1);

			planModel = { provider: chosenProvider, id: chosenId };
			persistState();
			setStatus(ctx);
			ctx.ui.notify(`[plan-mode] Plan model set to ${formatModelId(planModel)}`, "info");
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

	// -- Notify on external model changes when plan mode is active -----------
	pi.on("model_select", async (event, ctx) => {
		if (!active) return;
		// If the user manually changed the model during planning, update our
		// planModel preference so the toggle-back captures the user's override.
		if (event.model && event.source !== "restore") {
			planModel = { provider: event.model.provider, id: event.model.id };
		}
	});

	// -- Restore persisted state on startup/reload/resume/fork ----------------
	pi.on("session_start", async (_event, ctx) => {
		try {
			active = false;
			codeModel = null;
			planModel = null;
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i] as { type: string; customType?: string; data?: unknown };
				if (e.type === "custom" && e.customType === STATE_TYPE) {
					const data = e.data as PlanState | undefined;
					if (data) {
						if (typeof data.active === "boolean") active = data.active;
						if (data.codeModel) codeModel = data.codeModel;
						if (data.planModel) planModel = data.planModel;
					}
					break;
				}
			}

			// If restoring into plan mode, switch to plan model
			if (active && planModel) {
				await switchToModelSlot(planModel, ctx);
			}
		} catch (err) {
			console.error("[plan-mode] Failed to restore state:", err);
			active = false;
			codeModel = null;
			planModel = null;
		}
		setStatus(ctx);
	});

	// -- Keep persisted state fresh on each turn -----------------------------
	let lastPersisted: { active: boolean; codeModel: string | null; planModel: string | null } | null = null;
	pi.on("turn_start", async () => {
		const key = {
			active,
			codeModel: modelSlotKey(codeModel),
			planModel: modelSlotKey(planModel),
		};
		if (
			!lastPersisted ||
			key.active !== lastPersisted.active ||
			key.codeModel !== lastPersisted.codeModel ||
			key.planModel !== lastPersisted.planModel
		) {
			persistState();
			lastPersisted = key;
		}
	});
}

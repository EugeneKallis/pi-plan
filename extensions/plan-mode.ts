/**
 * Plan Mode — read-only planning toggle for pi.
 *
 * `/plan`        toggle plan mode on/off
 * `Ctrl+Shift+P` same toggle (shortcut)
 *
 * While plan mode is ACTIVE:
 *   - `before_agent_start` appends a planning protocol to the system prompt:
 *     research deeply, produce a STEP-BY-STEP plan (goal → steps → files
 *     touched → risks → open questions), and make NO changes.
 *   - `tool_call` blocks the mutating built-ins (`edit`, `write`, `bash`) so
 *     the agent is physically read-only. `read`/`grep`/`find`/`ls` and any
 *     read-only custom tools stay available for exploration.
 *   - A status badge ("⊕ plan") is shown and a notify is emitted on toggle.
 *
 * While plan mode is INACTIVE: no injection, no blocking, badge cleared.
 *
 * When the agent lists open questions in the plan, this extension presents
 * them in a TUI where you can select a suggested answer or type your own.
 * Your answers are fed back to the agent so the plan can be refined.
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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const STATE_TYPE = "plan-state";
const STATUS_KEY = "plan-mode";
const BLOCKED_TOOLS = new Set(["edit", "write", "bash"]);

const PLAN_SYSTEM_PROMPT = [
	"",
	"# PLAN MODE — ACTIVE",
	"",
	"You are currently in PLAN MODE. Your sole objective is to build a clear,",
	"executable plan that you (or another agent) can run with afterward.",
	"",
	"Hard constraints while plan mode is on:",
	"- Do NOT modify files or run mutating commands. `edit`, `write`, and `bash`",
	"  are blocked. Use `read`, `grep`, `find`, `ls` to understand the codebase.",
	"- Do not attempt to install packages, run builds, or execute anything with",
	"  side effects. Reason from reading only.",
	"- If you genuinely cannot make progress without running something, note it",
	"  as an open question and ask the user instead of working around the block.",
	"",
	"Do this:",
	"1. Read the relevant files IN FULL (no offset/limit skipping) so you don't",
	"   miss details. Grep for related code and prior art.",
	"2. State the goal in one line, then lay out numbered steps. For each step:",
	"   what to change, why, and which function/file is touched.",
	"3. Call out risks, edge cases, and dependencies (other modules, tests,",
	"   migrations) that the change implies.",
	"4. List every file that will be modified or created.",
	"5. List open questions / assumptions that need user confirmation before",
	"   execution. Do not assume — ask when ambiguous.",
	"   For each question, format it clearly and include (Suggested: ...) or",
	"   (Options: ...) when you have a reasonable default or set of choices.",
	"   This helps the question resolver present selectable answers.",
	"",
	"Keep the plan tight and concrete — it is the handoff artifact for execution.",
	"When the user runs `/plan` again to turn plan mode OFF, you may proceed to",
	"execute the plan above, step by step.",
	"# /PLAN MODE",
].join("\n");

interface PlanState {
	active: boolean;
}

// ─── Question parsing ──────────────────────────────────────────────────────

interface OpenQuestion {
	question: string;
	suggestions: string[];
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getLastAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type: string; message?: AgentMessage; content?: unknown };
		if (e.type === "message" && e.message && isAssistantMessage(e.message)) {
			return e.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}
	}
	return "";
}

/**
 * Parse open questions from the agent's plan text.
 *
 * Looks for:
 * 1. Sections titled "Open Questions", "Questions", "Assumptions"
 * 2. Lines ending with "?" within those sections
 * 3. Bullet points or numbered items containing questions
 * 4. Suggested answers from (Suggested: ...), (Options: ...), or "(e.g. ...)"
 */
function parseOpenQuestions(text: string): OpenQuestion[] {
	const questions: OpenQuestion[] = [];

	// Find the Open Questions / Questions / Assumptions section
	const sectionHeaders = /(?:#{1,4}\s*)?(?:Open\s+[Qq]uestions|[Qq]uestions|[Aa]ssumptions|[Aa]ssumptions\s+to\s+[Vv]erify|Unresolved\s+[Ii]ssues)[:\s]*/g;
	const sectionMatch = sectionHeaders.exec(text);

	const searchFrom = sectionMatch ? sectionMatch.index + sectionMatch[0].length : 0;
	const sectionText = sectionMatch ? text.slice(searchFrom) : text;

	// Collect the lines within the section (until next ## heading or end)
	const sectionLines: string[] = [];
	for (const line of sectionText.split("\n")) {
		if (/^#{1,4}\s/.test(line) && !/^#{1,4}\s*(Open\s+[Qq]uestions|[Qq]uestions)/.test(line)) break;
		sectionLines.push(line);
	}

	// If no section found, fall back to scanning the entire text for ? lines
	const linesToScan = sectionMatch ? sectionLines : text.split("\n").filter((l) => l.includes("?"));

	for (const rawLine of linesToScan) {
		const line = rawLine.trim();
		if (!line) continue;
		if (!line.includes("?")) continue;
		if (line.startsWith("```") || line.startsWith("|") || /^#{1,4}\s/.test(line)) continue;

		// Extract the actual question text (remove bullet markers, numbering)
		let questionText = line.replace(/^[\s]*[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
		// Remove "Suggested:" suffix hints for the question text, capture them as suggestions
		let suggestions: string[] = [];

		// Pattern: (Suggested: ...) or (Options: ...) or (e.g. ...)
		const parenSuggestion = questionText.match(/\(([^)]*)\)\s*$/);
		if (parenSuggestion) {
			const hint = parenSuggestion[1];
			// Check if the parenthetical is a suggestion/options/e.g.
			if (/^(?:Suggested|Options|e\.g\.|i\.e\.)/i.test(hint)) {
				// Remove it from the question
				questionText = questionText.slice(0, parenSuggestion.index).trim();
				// Parse suggestions: could be comma-separated list after the label
				const content = hint.replace(/^(?:Suggested|Options|e\.g\.|i\.e\.)\s*[:\-]?\s*/i, "");
				suggestions = content.split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean);
			}
		}

		// Pattern: "X or Y?" — extract the options
		if (suggestions.length === 0 && /\b(or)\b/i.test(questionText) && questionText.endsWith("?")) {
			const orParts = questionText.split(/\s+or\s+/i);
			if (orParts.length >= 2) {
				// Try to extract meaningful options from "Should we use X or Y?" patterns
				const lastPart = orParts[orParts.length - 1].replace(/\?$/, "").trim();
				const secondLastPart = orParts[orParts.length - 2].trim();
				// Only use these if they're short (likely options, not full sentences)
				if (secondLastPart.length < 40 && lastPart.length < 40) {
					// Find all "X or Y" candidates in the question
					const orMatches = questionText.match(/(?:(\w+(?:\s+\w+){0,4})\s+or\s+(\w+(?:\s+\w+){0,4}))/gi);
					if (orMatches) {
						for (const match of orMatches) {
							const parts = match.split(/\s+or\s+/i);
							for (const p of parts) {
								const cleaned = p.replace(/[?.,!]$/, "").trim();
								if (cleaned && !suggestions.includes(cleaned)) suggestions.push(cleaned);
							}
						}
					}
				}
			}
		}

		// Clean up question text
		questionText = questionText.replace(/\s+/g, " ").trim();
		questionText = questionText.replace(/^[?]\s*/, "").trim();
		if (!questionText.endsWith("?")) questionText += "?";
		if (!questionText) continue;

		// De-duplicate by question text
		if (!questions.some((q) => q.question === questionText)) {
			questions.push({ question: questionText, suggestions });
		}
	}

	return questions;
}

// ─── Question TUI ──────────────────────────────────────────────────────────

interface QuestionResult {
	answer: string;
	wasCustom: boolean;
}

/**
 * Show a question TUI: the question text + selectable answer options +
 * a "Type something..." option that opens an inline editor.
 *
 * Returns the chosen answer or null if cancelled.
 */
async function showQuestionTUI(
	ctx: ExtensionContext,
	q: OpenQuestion,
	index: number,
	total: number,
): Promise<QuestionResult | null> {
	const allOptions: string[] = [...q.suggestions, "✏️  Type something..."];

	const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean } | null>(
		(tui, theme, _kb, done) => {
			let optionIndex = 0;
			let editMode = false;
			let cachedLines: string[] | undefined;

			const editorTheme: EditorTheme = {
				borderColor: (s: string) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (trimmed) {
					done({ answer: trimmed, wasCustom: true });
				} else {
					editMode = false;
					editor.setText("");
					refresh();
				}
			};

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function handleInput(data: string) {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						editor.setText("");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
					refresh();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const selected = allOptions[optionIndex];
					if (selected.startsWith("✏️")) {
						editMode = true;
						refresh();
					} else {
						done({ answer: selected, wasCustom: false });
					}
					return;
				}

				if (matchesKey(data, Key.escape)) {
					done(null);
				}
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const lines: string[] = [];
				const renderWidth = Math.max(1, width);

				function addWrapped(text: string) {
					lines.push(...wrapTextWithAnsi(text, renderWidth));
				}

				function addWrappedWithPrefix(prefix: string, text: string) {
					const prefixWidth = visibleWidth(prefix);
					if (prefixWidth >= renderWidth) {
						addWrapped(prefix + text);
						return;
					}
					const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
					const continuationPrefix = " ".repeat(prefixWidth);
					for (let i = 0; i < wrapped.length; i++) {
						lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
					}
				}

				lines.push(theme.fg("accent", "─".repeat(renderWidth)));
				addWrappedWithPrefix(" ", theme.fg("dim", `Question ${index}/${total}`));
				addWrappedWithPrefix(" ", theme.fg("text", q.question));
				lines.push("");

				for (let i = 0; i < allOptions.length; i++) {
					const opt = allOptions[i];
					const selected = i === optionIndex;
					const isCustom = opt.startsWith("✏️");
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = `${i + 1}. ${opt}`;
					const color = selected ? "accent" : isCustom ? "warning" : "text";

					addWrappedWithPrefix(prefix, theme.fg(color, label));
				}

				if (editMode) {
					lines.push("");
					addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
					for (const editorLine of editor.render(Math.max(1, renderWidth - 2))) {
						lines.push(` ${editorLine}`);
					}
				}

				lines.push("");
				if (editMode) {
					addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
				} else {
					addWrappedWithPrefix(" ", theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel all questions"));
				}
				lines.push(theme.fg("accent", "─".repeat(renderWidth)));

				cachedLines = lines;
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
				},
				handleInput,
			};
		},
	);

	if (!result) return null;
	return result;
}

export default function (pi: ExtensionAPI) {
	// In-memory mode flag. Single source of truth at runtime; persisted via
	// appendEntry so reload/resume/fork restore it.
	let active = false;
	// Tracks whether we're in the middle of a question-answer cycle to avoid
	// re-triggering question detection on the follow-up turn.
	let resolvingQuestions = false;

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
		resolvingQuestions = false;
		pi.appendEntry(STATE_TYPE, { active } satisfies PlanState);
		setStatus(ctx);
	}

	async function toggle(ctx: ExtensionContext) {
		setMode(!active, ctx);
		ctx.ui.notify(
			active ? "Plan mode ON — read-only, draft a plan." : "Plan mode OFF — execute the plan.",
			active ? "info" : "success",
		);
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
				reason: `Plan mode is active — \`${event.toolName}\` is read-only-blocked. Research with read/grep/find/ls, then run /plan to turn plan mode OFF and execute.`,
			};
		}
	});

	// -- Open questions resolver ----------------------------------------------
	// After the agent finishes a turn in plan mode, check if the response
	// contains open questions. If so, present them in a TUI and feed the
	// answers back to the agent.
	pi.on("agent_end", async (_event, ctx) => {
		if (!active || resolvingQuestions) return;

		if (!ctx.hasUI) return;

		const lastText = getLastAssistantText(ctx);
		const questions = parseOpenQuestions(lastText);

		if (questions.length === 0) return;

		resolvingQuestions = true;

		const answers: { question: string; answer: string }[] = [];

		for (let i = 0; i < questions.length; i++) {
			const q = questions[i];
			const result = await showQuestionTUI(ctx, q, i + 1, questions.length);

			if (!result) {
				// User cancelled — stop resolving
				ctx.ui.notify("Question resolution cancelled. Plan remains with open questions.", "warning");
				resolvingQuestions = false;
				return;
			}

			answers.push({ question: q.question, answer: result.answer });
		}

		resolvingQuestions = false;

		// Build a summary of answers to feed back to the agent
		const answersText = answers
			.map((a, i) => `${i + 1}. **${a.question}**\n   → ${a.answer}`)
			.join("\n\n");

		ctx.ui.notify(`Answered ${answers.length} question(s). Feeding back to refine the plan.`, "success");

		// Send the answers as a follow-up message so the agent can refine the plan
		pi.sendUserMessage(
			[
				{ type: "text", text: "Here are my answers to your open questions. Please refine the plan accordingly.\n\n" + answersText },
			],
			{ deliverAs: "followUp" },
		);
	});

	// -- Restore persisted state on startup/reload/resume/fork ----------------
	pi.on("session_start", async (_event, ctx) => {
		active = false; // default for a fresh session
		resolvingQuestions = false;
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
		setStatus(ctx);
	});

	// -- Keep persisted state fresh on each turn -----------------------------
	pi.on("turn_start", async () => {
		pi.appendEntry(STATE_TYPE, { active } satisfies PlanState);
	});
}

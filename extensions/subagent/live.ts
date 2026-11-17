/**
 * Live progress widget for running subagents.
 *
 * While a subagent runs, the widget above the editor shows one line per
 * run: agent, model, thinking level, current activity, turns, and cost.
 * The activity gives up columns first, so the line never wraps. A blank
 * line below the widget keeps it away from the editor border. The widget
 * clears when no run is active.
 *
 * A command cannot show live data: commands run only while the agent is
 * idle, and subagents run while the agent is busy. The widget is the only
 * surface that updates during a run.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatModelThinking, formatToolCall, getDisplayItems, type ThemeFg, type ThemeLike } from "./render.ts";
import type { SingleResult } from "./types.ts";

const LIVE_WIDGET_NAME = "subagent";
const ACTIVITY_PREVIEW_LENGTH = 60;
const WIDGET_PADDING_X = 1;
const ELLIPSIS = "…";

/** Part of the tool context that the widget needs. */
export interface LiveWidgetContext {
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "theme" | "setWidget">;
}

/** One widget line, in three parts. */
interface LiveRow {
	/** Icon, agent name, model, thinking level, and the dash. */
	head: string;
	/** Current activity. This part gives up columns first. */
	activity: string;
	/** Turns and cost, with the leading separator. */
	tail: string;
}

/** Last activity of a run: the last tool call, or the last text line. */
function lastActivity(result: SingleResult, themeFg: ThemeFg): string {
	const items = getDisplayItems(result.messages);
	const last = items[items.length - 1];
	if (!last) return themeFg("muted", "(starting)");
	if (last.type === "toolCall") return formatToolCall(last.name, last.args, themeFg);
	const firstLine = last.text.split("\n")[0] ?? "";
	const preview =
		firstLine.length > ACTIVITY_PREVIEW_LENGTH ? `${firstLine.slice(0, ACTIVITY_PREVIEW_LENGTH)}...` : firstLine;
	return themeFg("toolOutput", preview);
}

/** Build the parts of one widget line. */
function buildRow(result: SingleResult, theme: ThemeLike, themeFg: ThemeFg): LiveRow {
	const meta = formatModelThinking(result.model, result.thinking, themeFg);
	const usage: string[] = [];
	if (result.usage.turns) usage.push(`${result.usage.turns}t`);
	if (result.usage.cost) usage.push(`$${result.usage.cost.toFixed(4)}`);

	const head =
		`${themeFg("warning", "⏳")} ${themeFg("toolTitle", theme.bold(result.agent))}` +
		(meta ? ` ${themeFg("muted", "·")} ${meta}` : "") +
		` ${themeFg("muted", "—")} `;
	return {
		head,
		// A tab counts as one column in the width math, but eight on the
		// terminal. Replace the tabs to keep the line math correct.
		activity: lastActivity(result, themeFg).replace(/\t/g, "   "),
		tail: usage.length > 0 ? themeFg("dim", `  · ${usage.join(" ")}`) : "",
	};
}

/** One line, with the activity shortened to fit the available width. */
function renderRow(row: LiveRow, available: number): string {
	const budget = available - visibleWidth(row.head) - visibleWidth(row.tail);
	if (budget <= 0) return truncateToWidth(row.head + row.activity + row.tail, available, ELLIPSIS);
	return row.head + truncateToWidth(row.activity, budget, ELLIPSIS) + row.tail;
}

/** Widget component: one line per run, padded to the width, then one blank line. */
function liveWidget(rows: LiveRow[]): Component {
	const padding = " ".repeat(WIDGET_PADDING_X);
	return {
		render(width: number): string[] {
			const available = Math.max(1, width - WIDGET_PADDING_X);
			const lines = rows.map((row) => {
				const line = padding + renderRow(row, available);
				return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
			});
			// One blank line keeps the widget away from the editor border.
			lines.push(" ".repeat(width));
			return lines;
		},
		invalidate(): void {},
	};
}

/** Show the running subagents, or clear the widget when no run is active. */
export function updateLiveWidget(ctx: LiveWidgetContext, running: SingleResult[]): void {
	if (!ctx.hasUI) return;
	if (running.length === 0) {
		ctx.ui.setWidget(LIVE_WIDGET_NAME, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const themeFg = theme.fg.bind(theme);
	ctx.ui.setWidget(LIVE_WIDGET_NAME, () => liveWidget(running.map((result) => buildRow(result, theme, themeFg))));
}

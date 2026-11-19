/**
 * /subagent-list and /subagent-runs commands.
 *
 * /subagent-list shows the available agents and their configuration.
 * /subagent-runs shows the finished runs of the subagent tool, with the
 * full transcript of each run.
 *
 * Both commands need interactive mode. Commands run only while the agent
 * is idle, so the runs view shows finished work only.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { readTranscript } from "./persistence.ts";
import {
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFailureEvidence,
	getFinalOutput,
	isFailedResult,
	plainStatusIcon,
	shortenPath,
	statusIcon,
	type ThemeLike,
} from "./render.ts";
import type { RunRecord, RunStore } from "./runs-store.ts";
import { updateLiveWidget, type LiveWidgetContext } from "./live.ts";

const SCROLL_VIEWPORT_MAX = 40;
const SCROLL_VIEWPORT_MIN = 10;
/** Space between the label column and the description of a run list item. */
const LABEL_COLUMN_GAP = 2;
/**
 * Zero-width space at the start of a run description. The select list trims
 * the description, which removes the left padding of the first column. This
 * character is not white space and takes no space in the terminal, so the
 * padding of the first column stays and the turns are right-aligned.
 */
const DESCRIPTION_ANCHOR = "\u200B";

/** First line of the task, at most maxLength characters. The mark of a cut counts. */
function taskPreview(task: string, maxLength: number): string {
	const oneLine = task.split("\n")[0] ?? "";
	if (oneLine.length <= maxLength) return oneLine;
	// There is no room for the three characters of the cut mark.
	if (maxLength <= 3) return oneLine.slice(0, maxLength);
	return `${oneLine.slice(0, maxLength - 3)}...`;
}

function sectionHeader(theme: ThemeLike, label: string): Text {
	return new Text(
		theme.fg("dim", "─── ") + theme.fg("accent", theme.bold(label)) + theme.fg("dim", " ───"),
		0,
		0,
	);
}

function requireTui(ctx: ExtensionCommandContext): boolean {
	if (ctx.mode === "tui") return true;
	ctx.ui.notify("This command needs interactive mode.", "error");
	return false;
}

/**
 * Scrollable full-screen text for one of several items. The user scrolls
 * with the arrow keys. When the screen has more than one item, the left
 * and right keys move to the item before or after the current item, and
 * wrap around at the ends. The title line shows the current position.
 * Esc returns to the list that opened the screen.
 */
async function showScrollScreen<T>(
	ctx: ExtensionCommandContext,
	items: T[],
	startIndex: number,
	getTitle: (item: T) => string,
	buildContent: (item: T, theme: ThemeLike) => Container,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const hasNeighbours = items.length > 1;
		let index = startIndex;
		let content = buildContent(items[index], theme);
		const topBorder = new DynamicBorder((s) => theme.fg("accent", s));
		const bottomBorder = new DynamicBorder((s) => theme.fg("accent", s));
		let cachedWidth: number | undefined;
		let cachedLines: string[] = [];
		let scrollTop = 0;

		// Show another item: build its content anew and start at the top.
		// The step wraps around at both ends of the list.
		const showItem = (step: number): void => {
			index = (index + step + items.length) % items.length;
			content = buildContent(items[index], theme);
			cachedWidth = undefined;
			cachedLines = [];
			scrollTop = 0;
			tui.requestRender();
		};

		const viewportHeight = () =>
			Math.max(SCROLL_VIEWPORT_MIN, Math.min(tui.terminal.rows - 6, SCROLL_VIEWPORT_MAX));

		const clampScroll = () => {
			const maxScroll = Math.max(0, cachedLines.length - viewportHeight());
			scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
		};

		return {
			// Own the page keys so they scroll the detail view, not the fullscreen transcript.
			capturesViewportInput: true,
			render(width: number): string[] {
				if (cachedWidth !== width) {
					cachedWidth = width;
					cachedLines = content.render(width);
				}
				clampScroll();
				const height = viewportHeight();
				const body = cachedLines.slice(scrollTop, scrollTop + height);
				const marks: string[] = [];
				if (cachedLines.length > height) {
					marks.push(`[${scrollTop + 1}-${scrollTop + body.length} of ${cachedLines.length}]`);
				}
				if (hasNeighbours) marks.push(`${index + 1}/${items.length}`);
				const position = marks.length > 0 ? theme.fg("dim", `  ${marks.join(" · ")}`) : "";
				const titleLine = truncateToWidth(
					theme.fg("toolTitle", theme.bold(getTitle(items[index]))) + position,
					width,
				);
				const navHint = hasNeighbours ? "←→ run · " : "";
				const footer = truncateToWidth(
					theme.fg("dim", `${navHint}↑↓ scroll · PgUp/PgDn page · Esc back`),
					width,
				);
				return [
					...topBorder.render(width),
					titleLine,
					...body,
					footer,
					...bottomBorder.render(width),
				];
			},
			handleInput(data: string): void {
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
					return;
				}
				if (hasNeighbours) {
					if (matchesKey(data, "left")) {
						showItem(-1);
						return;
					}
					if (matchesKey(data, "right")) {
						showItem(1);
						return;
					}
				}
				const height = viewportHeight();
				let moved = false;
				if (keybindings.matches(data, "tui.select.up")) {
					scrollTop -= 1;
					moved = true;
				} else if (keybindings.matches(data, "tui.select.down")) {
					scrollTop += 1;
					moved = true;
				} else if (keybindings.matches(data, "tui.select.pageUp")) {
					scrollTop -= height;
					moved = true;
				} else if (keybindings.matches(data, "tui.select.pageDown")) {
					scrollTop += height;
					moved = true;
				}
				if (!moved) return;
				clampScroll();
				tui.requestRender();
			},
			invalidate(): void {
				cachedWidth = undefined;
				content.invalidate();
			},
		};
	});
}

/** Full transcript of one run: header, task, tool calls, final output. */
function buildRunContent(record: RunRecord, theme: ThemeLike): Container {
	const r = record.result;
	const container = new Container();
	const fg = theme.fg.bind(theme);

	container.addChild(
		new Text(
			`${statusIcon(r.status, fg)} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`,
			0,
			0,
		),
	);

	const statusParts: string[] = [r.status];
	if (r.exitCode !== null) statusParts.push(`exit ${r.exitCode}`);
	if (r.stopReason) statusParts.push(r.stopReason);
	if (r.terminationSignal) statusParts.push(`signal ${r.terminationSignal}`);
	container.addChild(new Text(theme.fg(isFailedResult(r) ? "error" : "success", statusParts.join(" · ")), 0, 0));

	const usage = formatUsageStats(r.usage, r.model, r.thinking);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));

	const metaParts: string[] = [];
	if (r.cwd) metaParts.push(`cwd ${shortenPath(r.cwd)}`);
	if (record.finishedAt && record.finishedAt !== record.recordedAt) {
		metaParts.push(`started ${new Date(record.recordedAt).toLocaleTimeString()}`);
		metaParts.push(`finished ${new Date(record.finishedAt).toLocaleTimeString()}`);
	} else {
		metaParts.push(`completed ${new Date(record.recordedAt).toLocaleTimeString()}`);
	}
	container.addChild(new Text(theme.fg("dim", metaParts.join(" · ")), 0, 0));

	if (r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	if (r.stderr.trim()) container.addChild(new Text(theme.fg("error", `stderr: ${r.stderr.trim()}`), 0, 0));

	container.addChild(new Spacer(1));
	container.addChild(sectionHeader(theme, "Task"));
	container.addChild(new Text(theme.fg("text", r.task), 0, 0));

	container.addChild(new Spacer(1));
	container.addChild(sectionHeader(theme, "Transcript"));
	// A rebuilt run has no transcript in memory. Load it from the cache
	// file when one exists.
	const transcript =
		r.messages.length > 0 ? r.messages : record.transcriptFile ? readTranscript(record.transcriptFile) : null;
	const restored = (transcript?.length ?? 0) === 0 && record.restoredOutput !== undefined;
	const displayItems = transcript ? getDisplayItems(transcript) : [];
	if (restored) {
		container.addChild(
			new Text(theme.fg("muted", "(no transcript: this run was restored from the session file)"), 0, 0),
		);
	} else if (displayItems.length === 0) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(new Text(theme.fg("accent", "→ ") + formatToolCall(item.name, item.args, fg), 0, 0));
			} else {
				container.addChild(new Text(theme.fg("toolOutput", item.text), 0, 0));
			}
		}
	}

	const output = restored
		? record.restoredOutput
		: isFailedResult(r)
			? getFailureEvidence(r)
			: getFinalOutput(transcript ?? r.messages);
	container.addChild(new Spacer(1));
	if (isFailedResult(r)) {
		container.addChild(sectionHeader(theme, "Failure"));
		container.addChild(new Text(theme.fg("error", output), 0, 0));
	} else if (output) {
		container.addChild(sectionHeader(theme, "Final output"));
		container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
	}

	return container;
}

/** One list row, split into columns so that each column starts at the same place. */
interface RunRow {
	/** Run number in a fixed gutter, status icon, and agent name. */
	label: string;
	turns: string;
	cost: string;
}

function buildRunRow(record: RunRecord, numberWidth: number): RunRow {
	const r = record.result;
	return {
		label: `${String(record.number).padStart(numberWidth)} ${plainStatusIcon(r.status)} ${r.agent}`,
		turns: `${r.usage.turns}t`,
		cost: `$${r.usage.cost.toFixed(4)}`,
	};
}

/** Width of the widest value, in characters. All column values are one column wide. */
function widestValue(values: string[]): number {
	return values.reduce((widest, value) => Math.max(widest, value.length), 0);
}

/** Right-align a value in a column of the given width. */
function rightAlign(value: string, width: number): string {
	return value.padStart(width);
}

/**
 * Length of the task preview in a dialog of the given width. The select list
 * uses two columns for the selection prefix and two columns after the
 * description. Each of the two column separators is three columns wide.
 */
function taskPreviewLength(columns: number, labelWidth: number, turnsWidth: number, costWidth: number): number {
	const rest = 2 + labelWidth + turnsWidth + costWidth + 2 * 3 + 2;
	return Math.max(0, columns - rest);
}

/** Items of the run list, newest first, and the width of their label column. */
interface RunList {
	items: SelectItem[];
	labelWidth: number;
}

/**
 * Select-list items of the runs, newest first. The run number, the turns,
 * and the cost use fixed columns, so that the separators and the task
 * previews line up. The task preview fills the width that is left.
 */
function runListItems(runs: RunRecord[], columns: number): RunList {
	const numberWidth = widestValue(runs.map((run) => String(run.number)));
	const rows = runs.map((run) => buildRunRow(run, numberWidth));
	const turnsWidth = widestValue(rows.map((row) => row.turns));
	const costWidth = widestValue(rows.map((row) => row.cost));
	const labelWidth = widestValue(rows.map((row) => row.label)) + LABEL_COLUMN_GAP;
	const taskLength = taskPreviewLength(columns, labelWidth, turnsWidth, costWidth);
	const items = rows.map((row, index) => {
		const parts = [DESCRIPTION_ANCHOR + rightAlign(row.turns, turnsWidth), rightAlign(row.cost, costWidth)];
		if (taskLength > 0) parts.push(taskPreview(runs[index].result.task, taskLength));
		return { value: String(index), label: row.label, description: parts.join(" · ") };
	});
	return { items, labelWidth };
}

/** Duration between the first run start and the last run finish. */
function formatSpan(runs: RunRecord[]): string {
	if (runs.length === 0) return "0s";
	const first = Math.min(...runs.map((run) => run.recordedAt));
	const last = Math.max(...runs.map((run) => run.finishedAt ?? run.recordedAt));
	const seconds = Math.max(0, Math.round((last - first) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Single-line list header: title, then status counts, span, and cost. */
function addListHeader(container: Container, runs: RunRecord[], theme: ThemeLike): void {
	const failed = runs.filter((run) => isFailedResult(run.result)).length;
	const cost = runs.reduce((sum, run) => sum + run.result.usage.cost, 0);
	const separator = theme.fg("muted", " · ");
	const stats = [
		theme.fg("success", `✓ ${runs.length - failed}`),
		theme.fg("error", `✗ ${failed}`),
		theme.fg("dim", `◷ ${formatSpan(runs)}`),
		theme.fg("accent", `$${cost.toFixed(4)}`),
	].join(separator);
	container.addChild(
		new Text(theme.fg("accent", theme.bold("Subagent runs")) + separator + stats, 1, 0),
	);
}

/**
 * Select list of runs, newest first. The selection starts at startIndex.
 * Returns the index of the selected run, or null on cancel.
 */
async function showRunList(
	ctx: ExtensionCommandContext,
	runs: RunRecord[],
	startIndex: number,
): Promise<number | null> {
	const selectedIndex = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		// Size the label column to its content. The default column is wider
		// and leaves a large gap before the turns.
		const { items, labelWidth } = runListItems(runs, tui.terminal.columns);
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		addListHeader(container, runs, theme);

		const selectList = new SelectList(
			items,
			Math.min(items.length, 12),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
			{ minPrimaryColumnWidth: labelWidth, maxPrimaryColumnWidth: labelWidth },
		);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		selectList.setSelectedIndex(startIndex);
		container.addChild(selectList);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ move · Enter open · ←→ change run in detail · Esc close"), 1, 0),
		);
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			capturesViewportInput: selectList.capturesViewportInput,
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (selectedIndex === null) return null;
	return Number(selectedIndex);
}

/** Configuration and system prompt of one agent. */
function buildAgentContent(agent: AgentConfig, theme: ThemeLike): Container {
	const container = new Container();

	container.addChild(
		new Text(
			`${theme.fg("toolTitle", theme.bold(agent.name))}${theme.fg("muted", ` (${agent.source})`)}`,
			0,
			0,
		),
	);
	container.addChild(new Text(theme.fg("muted", agent.description), 0, 0));

	container.addChild(new Spacer(1));
	container.addChild(sectionHeader(theme, "Config"));
	container.addChild(new Text(theme.fg("dim", `file: ${shortenPath(agent.filePath)}`), 0, 0));
	container.addChild(new Text(theme.fg("dim", `model: ${agent.model ?? "(inherits session model)"}`), 0, 0));
	container.addChild(new Text(theme.fg("dim", `thinking: ${agent.thinking ?? "(inherits session level)"}`), 0, 0));
	container.addChild(
		new Text(theme.fg("dim", `tools: ${agent.tools?.join(", ") ?? "(inherits default tools)"}`), 0, 0),
	);

	container.addChild(new Spacer(1));
	container.addChild(sectionHeader(theme, "System prompt"));
	container.addChild(new Text(theme.fg("toolOutput", agent.systemPrompt), 0, 0));

	return container;
}

/**
 * Select list of agents. The selection starts at startIndex.
 * Returns the selected agent, or null on cancel.
 */
async function showAgentList(
	ctx: ExtensionCommandContext,
	agents: AgentConfig[],
	startIndex: number,
): Promise<AgentConfig | null> {
	const items: SelectItem[] = agents.map((agent) => ({
		value: agent.name,
		label: agent.name,
		description: `(${agent.source}) · ${agent.description}`,
	}));

	const selectedName = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Subagents ─ ${agents.length} found`)), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		selectList.setSelectedIndex(startIndex);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ move · Enter open · Esc close"), 1, 0));
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			capturesViewportInput: selectList.capturesViewportInput,
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!selectedName) return null;
	return agents.find((agent) => agent.name === selectedName) ?? null;
}

async function showAgentDetail(ctx: ExtensionCommandContext, agent: AgentConfig): Promise<void> {
	await showScrollScreen(ctx, [agent], 0, (item) => `Subagent · ${item.name}`, buildAgentContent);
}

/** Title of the detail screen of one run. */
function runTitle(run: RunRecord): string {
	return `Run ${run.number} · ${run.result.agent}`;
}

/**
 * /subagent-widget: toggle the live progress widget on or off.
 * The toggle applies at once and is written to the user settings file.
 */
export function registerWidgetToggleCommand(
	pi: ExtensionAPI,
	isEnabled: () => boolean,
	setEnabled: (enabled: boolean) => boolean,
	clearWidget: (ctx: LiveWidgetContext) => void,
	redrawWidget: (ctx: LiveWidgetContext) => void,
): void {
	pi.registerCommand("subagent-widget", {
		description: "Toggle the live subagent progress widget on or off",
		handler: async (_args, ctx) => {
			const next = !isEnabled();
			const persisted = setEnabled(next);
			// Redraw at once when the widget goes on: the next run update
			// alone would come too late for a run in progress.
			if (next) redrawWidget(ctx);
			else clearWidget(ctx);
			const state = next ? "on" : "off";
			const note = persisted
				? state
				: `${state} for this session only: the settings file could not be written`;
			ctx.ui.notify(`Subagent widget ${note}.`, "info");
		},
	});
}

export function registerSubagentCommands(pi: ExtensionAPI, runStore: RunStore): void {
	pi.registerCommand("subagent-list", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;

			const agents = discoverAgents(ctx.cwd, "both").agents;
			if (agents.length === 0) {
				ctx.ui.notify("No agents found. Add agent files to ~/.pi/agent/agents/ or .pi/agents/.", "warning");
				return;
			}

			// Esc in the detail view returns to the list at the same agent.
			let startIndex = 0;
			for (;;) {
				const selected = await showAgentList(ctx, agents, startIndex);
				if (!selected) return;
				await showAgentDetail(ctx, selected);
				startIndex = agents.indexOf(selected);
			}
		},
	});

	pi.registerCommand("subagent-runs", {
		description: "Browse subagent runs",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;

			const runs = runStore.allNewestFirst();
			if (runs.length === 0) {
				ctx.ui.notify("No subagent runs in this session yet. Delegate a task to a subagent first.", "info");
				return;
			}

			// Esc in the detail view returns to the list at the same run.
			let startIndex = 0;
			for (;;) {
				const index = await showRunList(ctx, runs, startIndex);
				if (index === null) return;
				await showScrollScreen(ctx, runs, index, runTitle, buildRunContent);
				startIndex = index;
			}
		},
	});
}

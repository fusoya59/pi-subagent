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
import type { SingleResult } from "./types.ts";

const TASK_PREVIEW_LENGTH = 70;
const SCROLL_VIEWPORT_MAX = 40;
const SCROLL_VIEWPORT_MIN = 10;

function taskPreview(task: string): string {
	const oneLine = task.split("\n")[0] ?? "";
	return oneLine.length > TASK_PREVIEW_LENGTH ? `${oneLine.slice(0, TASK_PREVIEW_LENGTH)}...` : oneLine;
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
 * Scrollable full-screen text. The user pages through the content with
 * the arrow keys. The title line shows the current position.
 */
async function showScrollScreen(
	ctx: ExtensionCommandContext,
	title: string,
	buildContent: (theme: ThemeLike) => Container,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const content = buildContent(theme);
		const topBorder = new DynamicBorder((s) => theme.fg("accent", s));
		const bottomBorder = new DynamicBorder((s) => theme.fg("accent", s));
		let cachedWidth: number | undefined;
		let cachedLines: string[] = [];
		let scrollTop = 0;

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
				const position =
					cachedLines.length > height
						? theme.fg("dim", `  [${scrollTop + 1}-${scrollTop + body.length} of ${cachedLines.length}]`)
						: "";
				const titleLine = truncateToWidth(theme.fg("toolTitle", theme.bold(title)) + position, width);
				const footer = truncateToWidth(theme.fg("dim", "↑↓ scroll · PgUp/PgDn page · Esc close"), width);
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

/** One line per list item: turns, cost, and task preview. */
function runItemDescription(r: SingleResult): string {
	const cost = r.usage.cost ? `$${r.usage.cost.toFixed(4)}` : "$0";
	return `${r.usage.turns}t · ${cost} · ${taskPreview(r.task)}`;
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

/** Select list of runs, newest first. Returns the selected record, or null on cancel. */
async function showRunList(ctx: ExtensionCommandContext, store: RunStore): Promise<RunRecord | null> {
	const runs = store.allNewestFirst();
	if (runs.length === 0) {
		ctx.ui.notify("No subagent runs in this session yet. Delegate a task to a subagent first.", "info");
		return null;
	}

	const items: SelectItem[] = runs.map((run) => ({
		value: String(run.number),
		label: `${run.number} ${plainStatusIcon(run.result.status)} ${run.result.agent}`,
		description: runItemDescription(run.result),
	}));

	const selectedNumber = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		addListHeader(container, runs, theme);

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
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

	if (!selectedNumber) return null;
	return store.get(Number(selectedNumber)) ?? null;
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

/** Select list of agents. Returns the selected agent, or null on cancel. */
async function showAgentList(ctx: ExtensionCommandContext, agents: AgentConfig[]): Promise<AgentConfig | null> {
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
	await showScrollScreen(ctx, `Subagent · ${agent.name}`, (theme) => buildAgentContent(agent, theme));
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

			const selected = await showAgentList(ctx, agents);
			if (selected) await showAgentDetail(ctx, selected);
		},
	});

	pi.registerCommand("subagent-runs", {
		description: "Browse subagent runs",
		handler: async (_args, ctx) => {
			if (!requireTui(ctx)) return;

			if (runStore.size === 0) {
				ctx.ui.notify("No subagent runs in this session yet. Delegate a task to a subagent first.", "info");
				return;
			}

			const run = await showRunList(ctx, runStore);
			if (run) {
				await showScrollScreen(
					ctx,
					`Run ${run.number} · ${run.result.agent}`,
					(theme) => buildRunContent(run, theme),
				);
			}
		},
	});
}

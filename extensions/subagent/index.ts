/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Delegates one task to a specialized subagent with an isolated context.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatReadLineRange,
	getAgentDir,
	getMarkdownTheme,
	type JsonAgentSessionEvent,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const COLLAPSED_ITEM_COUNT = 10;
const TRUNCATION_NOTICE_RESERVE = 256;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type ChildStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface SingleResult {
	agent: string;
	agentSource: "package" | "user" | "project" | "unknown";
	task: string;
	status: ChildStatus;
	exitCode: number | null;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	terminationSignal?: NodeJS.Signals;
	step?: number;
}

interface SubagentDetails {
	mode: "single";
	results: SingleResult[];
	isError: boolean;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.status === "failed" || result.status === "aborted";
}

function getFailureEvidence(result: SingleResult): string {
	const evidence: string[] = [];
	const seen = new Set<string>();
	const add = (label: string, value: string | undefined) => {
		const text = value?.trim();
		if (!text || seen.has(text)) return;
		seen.add(text);
		evidence.push(`${label}: ${text}`);
	};

	add("Error", result.errorMessage);
	add("Signal", result.terminationSignal);
	add("stderr", result.stderr);
	add("Assistant output", getFinalOutput(result.messages));
	return evidence.join("\n\n") || "(no output)";
}

function getResultOutput(result: SingleResult): string {
	return isFailedResult(result) ? getFailureEvidence(result) : getFinalOutput(result.messages) || "(no output)";
}

function truncateModelOutput(output: string): string {
	const initial = truncateHead(output);
	if (!initial.truncated) return output;

	const body = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES - 2,
		maxBytes: DEFAULT_MAX_BYTES - TRUNCATION_NOTICE_RESERVE,
	});
	const omittedBytes = initial.totalBytes - body.outputBytes;
	const notice = `[Output truncated: ${omittedBytes} bytes omitted. Full output preserved in tool details.]`;
	return body.content ? `${body.content}\n\n${notice}` : notice;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	// Bun-compiled binaries report their embedded entry as argv[1]: "/$bunfs/root/..." on
	// POSIX and "B:/~BUN/root/..." on Windows. fs.existsSync() resolves these inside Bun.
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface ProcessOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	spawnError?: Error;
}

interface ResolvedAgent {
	agent?: AgentConfig;
	available: AgentConfig[];
	cwd: string;
}

function resolveAgent(defaultCwd: string, scope: AgentScope, name: string, cwd?: string): ResolvedAgent {
	const effectiveCwd = path.resolve(defaultCwd, cwd ?? ".");
	const discovery = discoverAgents(effectiveCwd, scope);
	return {
		agent: discovery.agents.find((candidate) => candidate.name === name),
		available: discovery.agents,
		cwd: effectiveCwd,
	};
}

function createUnstartedResult(
	agent: string,
	task: string,
	step: number | undefined,
	status: "aborted" | "failed",
	errorMessage?: string,
): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		status,
		exitCode: null,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		errorMessage,
		step,
	};
}

async function runSingleAgent(
	dispatchDefaults: DispatchDefaults,
	resolvedAgent: ResolvedAgent,
	agentName: string,
	task: string,
	step: number | undefined,
	modelOverride: string | undefined,
	thinkingOverride: ThinkingLevel | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	if (signal?.aborted) {
		return createUnstartedResult(agentName, task, step, "aborted", "Subagent was aborted before starting");
	}

	const effectiveCwd = resolvedAgent.cwd;
	const agent = resolvedAgent.agent;
	if (!agent) {
		const available = resolvedAgent.available.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		return createUnstartedResult(
			agentName,
			task,
			step,
			"failed",
			`Unknown agent: "${agentName}". Available agents: ${available}.`,
		);
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const model = modelOverride ?? agent.model ?? dispatchDefaults.model;
	const thinking = thinkingOverride ?? agent.thinking ?? dispatchDefaults.thinkingLevel;
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		status: "running",
		exitCode: null,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		if (signal?.aborted) {
			currentResult.status = "aborted";
			currentResult.errorMessage = "Subagent was aborted before starting";
			return currentResult;
		}

		args.push(`Task: ${task}`);
		emitUpdate();
		let wasAborted = false;
		const outcome = await new Promise<ProcessOutcome>((resolve) => {
			const invocation = getPiInvocation(args);
			let settled = false;
			let exited = false;
			let closed = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: JsonAgentSessionEvent;
				try {
					event = JSON.parse(line) as JsonAgentSessionEvent;
				} catch {
					return;
				}
				if (event.type !== "message_end") return;
				const eventMessage = event.message;
				if (
					eventMessage.role !== "user" &&
					eventMessage.role !== "assistant" &&
					eventMessage.role !== "toolResult"
				) {
					return;
				}
				const message = eventMessage as Message;
				currentResult.messages.push(message);
				if (message.role === "assistant") {
					currentResult.usage.turns++;
					currentResult.usage.input += message.usage.input;
					currentResult.usage.output += message.usage.output;
					currentResult.usage.cacheRead += message.usage.cacheRead;
					currentResult.usage.cacheWrite += message.usage.cacheWrite;
					currentResult.usage.cost += message.usage.cost.total;
					currentResult.usage.contextTokens = message.usage.totalTokens;
					if (!currentResult.model) currentResult.model = message.model;
					currentResult.stopReason = message.stopReason;
					currentResult.errorMessage = message.errorMessage;
				}
				emitUpdate();
			};

			let proc: ReturnType<typeof spawn>;
			const finish = (result: ProcessOutcome) => {
				if (settled) return;
				settled = true;
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal) signal.removeEventListener("abort", abortProcess);
				resolve(result);
			};
			const abortProcess = () => {
				if (closed || exited || proc.exitCode !== null || proc.signalCode !== null) return;
				if (!proc.kill("SIGTERM")) return;
				wasAborted = true;
				killTimer = setTimeout(() => {
					if (!closed && !exited) proc.kill("SIGKILL");
				}, 5000);
			};

			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd: effectiveCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				finish({
					code: null,
					signal: null,
					spawnError: error instanceof Error ? error : new Error(String(error)),
				});
				return;
			}

			proc.stdout?.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr?.on("data", (data) => {
				currentResult.stderr += data.toString();
			});
			proc.on("exit", () => {
				exited = true;
			});
			proc.on("close", (code, terminationSignal) => {
				if (buffer.trim()) processLine(buffer);
				finish({ code, signal: terminationSignal });
			});
			proc.on("error", (error) => {
				finish({ code: null, signal: null, spawnError: error });
			});

			if (signal) {
				if (signal.aborted) abortProcess();
				else signal.addEventListener("abort", abortProcess, { once: true });
			}
		});

		currentResult.exitCode = outcome.code;
		currentResult.terminationSignal = outcome.signal ?? undefined;

		if (wasAborted) {
			currentResult.status = "aborted";
			currentResult.errorMessage ||= "Subagent was aborted";
		} else if (outcome.spawnError) {
			currentResult.status = "failed";
			currentResult.errorMessage = `Failed to spawn subagent: ${outcome.spawnError.message}`;
		} else if (outcome.signal) {
			currentResult.status = "failed";
			currentResult.errorMessage ||= `Subagent terminated by signal ${outcome.signal}`;
		} else if (outcome.code !== 0) {
			currentResult.status = "failed";
			currentResult.errorMessage ||= `Subagent exited with code ${outcome.code}`;
		} else if (currentResult.stopReason === "aborted") {
			currentResult.status = "aborted";
		} else if (currentResult.stopReason === "error") {
			currentResult.status = "failed";
		} else {
			currentResult.status = "completed";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
	description: "Thinking effort level for the subagent (defaults to agent frontmatter or parent session level)",
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(Type.String({ description: "Model ID override (provider/model or model)" })),
	thinking: Type.Optional(ThinkingLevelSchema),
});

export default function (pi: ExtensionAPI) {
	// Tool execute results cannot set runtime error state directly, so patch it through the result hook.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = event.details as SubagentDetails | undefined;
		if (details?.isError) return { isError: true };
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			`Default agent scope is "user" (agents from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasSingle = Boolean(params.agent && params.task);

			const makeDetails =
				(forceError = false) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode: "single",
					results,
					isError: forceError || results.some(isFailedResult),
				});

			if (!hasSingle) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide both agent and task.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails(true)([]),
				};
			}

			const resolvedSingle = params.agent ? resolveAgent(ctx.cwd, agentScope, params.agent, params.cwd) : undefined;

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const selectedAgents: ResolvedAgent[] = resolvedSingle ? [resolvedSingle] : [];
				const projectAgentsByPath = new Map<string, AgentConfig>();
				for (const resolved of selectedAgents) {
					if (resolved.agent?.source === "project") {
						projectAgentsByPath.set(resolved.agent.filePath, resolved.agent);
					}
				}

				const trustedProjectAgentsDir =
					ctx.isProjectTrusted() && discovery.projectAgentsDir
						? fs.realpathSync(discovery.projectAgentsDir)
						: undefined;
				const projectAgentsRequested = Array.from(projectAgentsByPath.values()).filter(
					(agent) =>
						!trustedProjectAgentsDir || fs.realpathSync(path.dirname(agent.filePath)) !== trustedProjectAgentsDir,
				);
				if (projectAgentsRequested.length > 0) {
					const sources = projectAgentsRequested.map((agent) => `- ${agent.name}: ${agent.filePath}`).join("\n");
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Sources:\n${sources}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails()([]),
						};
					}
				}
			}

			if (params.agent && params.task && resolvedSingle) {
				const result = await runSingleAgent(
					dispatchDefaults,
					resolvedSingle,
					params.agent,
					params.task,
					undefined,
					params.model,
					params.thinking,
					signal,
					onUpdate,
					makeDetails(),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: truncateModelOutput(`Agent ${result.stopReason || result.status}: ${errorMsg}`),
							},
						],
						details: makeDetails()([result]),
					};
				}
				return {
					content: [
						{
							type: "text",
							text: truncateModelOutput(getFinalOutput(result.messages) || "(no output)"),
						},
					],
					details: makeDetails()([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails(true)([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const resultIcon = (child: SingleResult): string => {
				if (child.status === "pending" || child.status === "running") {
					return theme.fg("warning", "⏳");
				}
				if (isFailedResult(child)) return theme.fg("error", "✗");
				return theme.fg("success", "✓");
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const isRunning = r.status === "pending" || r.status === "running";
				const icon = resultIcon(r);
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isRunning) header += ` ${theme.fg("warning", `[${r.status}]`)}`;
					else if (isError) header += ` ${theme.fg("error", `[${r.stopReason ?? r.status}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					if (r.terminationSignal)
						container.addChild(new Text(theme.fg("error", `Signal: ${r.terminationSignal}`), 0, 0));
					if (r.stderr.trim()) container.addChild(new Text(theme.fg("error", `stderr: ${r.stderr.trim()}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isRunning) text += ` ${theme.fg("warning", `[${r.status}]`)}`;
				else if (isError) text += ` ${theme.fg("error", `[${r.stopReason ?? r.status}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}

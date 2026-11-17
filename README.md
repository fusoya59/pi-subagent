# pi-subagent

Fork of Pi's `subagent` example extension. Runs specialized subagents in isolated `pi` processes and adds per-invocation `model` and `thinking` overrides plus frontmatter `thinking` support.

The extension also adds three commands: `/subagent-list`, `/subagent-runs`, and `/subagent-widget`.

## Installation

Install the public Git package:

```sh
pi install git:github.com/fusoya59/pi-subagent
```

Then run `/reload` in Pi.

The extension discovers agents from `~/.pi/agent/agents/`; project agents require `agentScope: "project"` or "both".

## Example Agents

The package does not load these files. Copy the ones you want to `~/.pi/agent/agents/` to use them.

| Agent | Purpose | Model |
|---|---|---|
| `explore` | Read-only codebase reconnaissance | `opencode-go/deepseek-v4.1-flash` |
| `plan-reviewer` | Audits implementation plans | `openai/gpt-6.1-terra` |
| `code-reviewer` | Reviews code diffs against plans | `agy/gemini-4-hydrogen` |
| `coder` | Implements changes per plan | `opencode-go/deepseek-v4.1-flash` |


## Parameters

The tool runs one subagent per call:

```js
const result = await tools.subagent({
  agent: "explore",
  task: "Inspect the authentication flow and report relevant files.",
  model: "agy/gemini-4-hydrogen",
  thinking: "low"
});
return result;
```

- **Scope:** `agentScope` (`"user"` default, `"project"`, or `"both"`), `confirmProjectAgents` (default `true`)
- **Working directory:** `cwd`
- **Thinking values:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`

### Parallel Work in Codemode

Use `Promise.all` or `Promise.allSettled` to run independent subagent calls concurrently:

```js
const results = await Promise.all([
  tools.subagent({ agent: "explore", task: "Inspect the API layer." }),
  tools.subagent({ agent: "explore", task: "Inspect the database layer." })
]);
return results;
```

### Chained Work in Codemode

Await one call, then pass its output to the next call. Use normal JavaScript variables instead of a built-in `{previous}` placeholder:

```js
const findings = await tools.subagent({
  agent: "explore",
  task: "Find the relevant files and summarize the current design."
});
const review = await tools.subagent({
  agent: "plan-reviewer",
  task: `Review these findings and propose a safe implementation plan:\n\n${findings}`
});
return review;
```

## Commands

The extension adds three commands. All need interactive mode.

| Command | Purpose |
|---|---|
| `/subagent-list` | List the available agents. Enter opens the configuration and system prompt. |
| `/subagent-runs` | Browse the runs of the current session. Enter opens the transcript, usage, and cost. |
| `/subagent-widget` | Toggle the live progress widget on or off. |

Keys: `↑↓`/`PgUp/PgDn` move or scroll, `Enter` opens, `Esc` closes.

Runs survive a restart and `/reload`. Direct runs rebuild from the session branch with their full transcripts. Nested runs, such as codemode calls, restore from summary entries and a transcript cache at `~/.pi/agent/subagent-transcripts/` (files older than 14 days are deleted).

## Live Progress

While a subagent runs, a widget above the editor shows one line per run:

```text
⏳ code-reviewer · gemini-4-hydrogen · hi — read src/app.ts  · 3t $0.0142
```

## Model and Thinking Precedence

Both `model` and `thinking` resolve in this order (highest to lowest):

1. Top-level tool parameter
2. Agent `.md` frontmatter
3. Parent session active setting

## Agent Markdown Format

```markdown
---
name: my-agent
description: Short summary of the agent role
tools: read, grep, find, ls, bash
model: agy/gemini-4-argon
thinking: medium
---

System prompt for the agent.
```

`name` and `description` are required (files missing either are skipped). All other fields are optional:

- **`model`:** Omit `model` to inherit the parent session's active model (unless overridden at tool invocation).
- **`thinking`:** Omit `thinking` to inherit the parent session's active thinking level (unless overridden at tool invocation).
- **`tools`:** Omit `tools` to inherit `defaultTools` and `codemode` settings from `settings.json`. Setting `tools` passes `--tools <list>` to `pi`, which replaces `defaultTools` (so include `codemode` if you use codemode, or use `+name`/`-name` entries to adjust `defaultTools`).

/**
 * User setting for the live subagent widget.
 *
 * The setting key is "subagentWidget" in ~/.pi/agent/settings.json.
 * Absent or true means the widget is on. The /subagent-widget command
 * toggles the setting and writes it, so the choice survives a restart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WIDGET_SETTING_KEY = "subagentWidget";

function userSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

/** Widget setting from merged settings. Absent or true means on. */
export function readWidgetSetting(settings: Record<string, unknown>): boolean {
	return settings[WIDGET_SETTING_KEY] !== false;
}

/**
 * Write the widget setting to the user settings file. Keep all other
 * keys. Throws if the file cannot be read or written.
 */
export function writeWidgetSetting(enabled: boolean): void {
	const filePath = userSettingsPath();
	let config: Record<string, unknown> = {};
	if (fs.existsSync(filePath)) {
		config = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
		if (typeof config !== "object" || config === null || Array.isArray(config)) {
			throw new Error("settings.json does not hold a settings object");
		}
	}
	config[WIDGET_SETTING_KEY] = enabled;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(config, null, "\t")}\n`);
}

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";

export type ConsoleDevice = {
	id: string;
	url: string;
	token: string;
	uid?: string;
	agents?: string[];
};
type ConsoleConfig = {
	version: 1;
	port: number;
	push: { enabled: false; subject: string };
};

export const consoleDir = () =>
	process.env.DURABLE_CONSOLE_DIR ||
	join(homedir(), ".config", "durable", "console");
export const devicesPath = () => join(consoleDir(), "devices.yaml");
export const consoleConfigPath = () => join(consoleDir(), "console.yaml");
export const vapidPath = () => join(consoleDir(), "vapid.json");
export const subscriptionsPath = () =>
	join(consoleDir(), "push-subscriptions.json");

function privateWrite(path: string, value: string) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, value, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function defaultConsoleConfig(): ConsoleConfig {
	return {
		version: 1,
		port: 4319,
		push: { enabled: false, subject: "mailto:operator@example.invalid" },
	};
}

export function loadConsoleConfig(path = consoleConfigPath()): ConsoleConfig {
	if (!existsSync(path)) return defaultConsoleConfig();
	const value = parse(readFileSync(path, "utf8")) as Partial<ConsoleConfig>;
	if (
		value.version !== 1 ||
		!Number.isInteger(value.port) ||
		(value.port ?? 0) < 1 ||
		(value.port ?? 0) > 65535 ||
		value.push?.enabled !== false ||
		typeof value.push.subject !== "string"
	)
		throw Error("invalid console.yaml");
	return value as ConsoleConfig;
}

export function ensureConsoleConfig(path = consoleConfigPath()) {
	if (!existsSync(path)) privateWrite(path, stringify(defaultConsoleConfig()));
	return loadConsoleConfig(path);
}

export function loadDevices(path = devicesPath()): ConsoleDevice[] {
	if (!existsSync(path)) return [];
	const value = parse(readFileSync(path, "utf8")) as {
		version?: unknown;
		devices?: unknown;
	};
	if (value?.version !== 1 || !Array.isArray(value.devices))
		throw Error("invalid devices.yaml");
	return value.devices.map((device) => {
		const entry = device as Partial<ConsoleDevice>;
		if (
			!/^[A-Za-z0-9._-]+$/.test(entry.id ?? "") ||
			typeof entry.url !== "string" ||
			!/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(entry.url) ||
			typeof entry.token !== "string"
		)
			throw Error("invalid console device");
		return {
			id: entry.id as string,
			url: entry.url,
			token: entry.token,
			uid: entry.uid,
			agents: entry.agents,
		};
	});
}

export function saveDevices(devices: ConsoleDevice[], path = devicesPath()) {
	privateWrite(path, stringify({ version: 1, devices }));
}

export function initializePushStores() {
	if (!existsSync(vapidPath()))
		privateWrite(vapidPath(), `${JSON.stringify({ version: 1 })}\n`);
	if (!existsSync(subscriptionsPath()))
		privateWrite(
			subscriptionsPath(),
			`${JSON.stringify({ version: 1, subscriptions: [] })}\n`,
		);
}

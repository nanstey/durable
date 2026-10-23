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
type StoredDevice = Omit<ConsoleDevice, "token"> & { token?: string };
type ConsoleConfig = {
	version: 1;
	port: number;
	allowedUsers: string[];
	serveHostname?: string;
	push: { enabled: false; subject: string };
};

export const consoleDir = () =>
	process.env.DURABLE_CONSOLE_DIR ||
	join(homedir(), ".config", "durable", "console");
export const devicesPath = () => join(consoleDir(), "devices.yaml");
const deviceTokenPath = (id: string) => join(consoleDir(), "tokens", id);
export const consoleConfigPath = () => join(consoleDir(), "console.yaml");
export const vapidPath = () => join(consoleDir(), "vapid.json");
export const subscriptionsPath = () =>
	join(consoleDir(), "push-subscriptions.json");

function privateWrite(path: string, value: string) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, value, { mode: 0o600 });
	chmodSync(path, 0o600);
}
function validId(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id);
}
function validUrl(url: unknown): url is string {
	if (typeof url !== "string") return false;
	try {
		const parsed = new URL(url);
		return (
			["http:", "https:"].includes(parsed.protocol) &&
			!parsed.username &&
			!parsed.password &&
			!parsed.search &&
			!parsed.hash
		);
	} catch {
		return false;
	}
}
function defaultConsoleConfig(): ConsoleConfig {
	return {
		version: 1,
		port: 4319,
		allowedUsers: [],
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
		typeof value.push.subject !== "string" ||
		!Array.isArray(value.allowedUsers) ||
		!value.allowedUsers.every((x) => typeof x === "string") ||
		(value.serveHostname !== undefined &&
			typeof value.serveHostname !== "string")
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
	let migrated = false;
	const devices = value.devices.map((device) => {
		const entry = device as Partial<StoredDevice>;
		if (
			!validId(entry.id) ||
			!validUrl(entry.url) ||
			(entry.uid !== undefined && typeof entry.uid !== "string") ||
			(entry.agents !== undefined &&
				(!Array.isArray(entry.agents) || !entry.agents.every(validId)))
		)
			throw Error("invalid console device");
		const tokenPath = deviceTokenPath(entry.id);
		if (!existsSync(tokenPath)) {
			if (!entry.token)
				throw Error(`missing token for console device ${entry.id}`);
			privateWrite(tokenPath, `${entry.token}\n`);
			migrated = true;
		}
		chmodSync(tokenPath, 0o600);
		return {
			id: entry.id,
			url: entry.url,
			...(entry.uid ? { uid: entry.uid } : {}),
			...(entry.agents ? { agents: entry.agents } : {}),
			token: readFileSync(tokenPath, "utf8").trim(),
		};
	});
	if (migrated)
		privateWrite(
			path,
			stringify({
				version: 1,
				devices: devices.map(({ token: _token, ...device }) => device),
			}),
		);
	return devices;
}
export function saveDevices(devices: ConsoleDevice[], path = devicesPath()) {
	const stored: StoredDevice[] = [];
	for (const { token, ...device } of devices) {
		if (!validId(device.id) || !validUrl(device.url) || !token)
			throw Error("invalid console device");
		privateWrite(deviceTokenPath(device.id), `${token}\n`);
		stored.push(device);
	}
	privateWrite(path, stringify({ version: 1, devices: stored }));
}
export function addDevice(device: ConsoleDevice) {
	const devices = loadDevices();
	if (devices.some((entry) => entry.id === device.id))
		throw Error("console device already exists");
	saveDevices([...devices, device]);
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

import type { ConsoleDevice } from "./registry.ts";

export type DeviceStatus =
	| "checking"
	| "online"
	| "offline"
	| "unauthorized"
	| "mismatch"
	| "incompatible";
export type DeviceState = {
	id: string;
	status: DeviceStatus;
	retryMs: number;
	checkedAt: number;
	detail?: string;
};

export class DeviceMonitor {
	readonly states = new Map<string, DeviceState>();
	private readonly devices: ConsoleDevice[];
	private readonly fetcher: typeof fetch;
	constructor(devices: ConsoleDevice[], fetcher: typeof fetch = fetch) {
		this.devices = devices;
		this.fetcher = fetcher;
	}
	// fallow-ignore-next-line unused-class-member
	state(id: string) {
		return this.states.get(id);
	}
	async check(device: ConsoleDevice): Promise<DeviceState> {
		const now = Date.now();
		const previous = this.states.get(device.id);
		const state: DeviceState = {
			id: device.id,
			status: "checking",
			retryMs: previous?.retryMs ?? 1000,
			checkedAt: now,
		};
		this.states.set(device.id, state);
		try {
			const health = await this.fetcher(new URL("/healthz", device.url), {
				signal: AbortSignal.timeout(5000),
			});
			const response = await this.fetcher(new URL("/v1/device", device.url), {
				headers: { authorization: `Bearer ${device.token}` },
				signal: AbortSignal.timeout(5000),
			});
			if (response.status === 401 || response.status === 403)
				state.status = "unauthorized";
			else if (!health.ok || !response.ok) state.status = "offline";
			else {
				const info = (await response.json()) as {
					uid?: string;
					apiVersion?: string;
				};
				state.status =
					device.uid && info.uid !== device.uid
						? "mismatch"
						: info.apiVersion !== "v1"
							? "incompatible"
							: "online";
			}
		} catch {
			state.status = "offline";
		}
		state.retryMs =
			state.status === "offline"
				? Math.min((previous?.retryMs ?? 500) * 2, 30_000)
				: 30_000;
		state.checkedAt = now;
		this.states.set(device.id, state);
		return state;
	}
	checkAll() {
		return Promise.all(this.devices.map((device) => this.check(device)));
	}
}

import { SystemdUserServiceManager } from "./systemdUser.ts";
import type { ServiceManager, ServiceStatus } from "./types.ts";

const linuxOnlyMessage =
	"durable services are supported only on Linux with systemd --user; skipping";

class UnsupportedServiceManager implements ServiceManager {
	private skip() {
		console.log(linuxOnlyMessage);
	}
	async install(): Promise<void> {
		this.skip();
	}
	async enable(): Promise<void> {
		this.skip();
	}
	async disable(): Promise<void> {
		this.skip();
	}
	async start(): Promise<void> {
		this.skip();
	}
	async stop(): Promise<void> {
		this.skip();
	}
	async status(): Promise<ServiceStatus> {
		return { active: false, text: linuxOnlyMessage };
	}
	async *logs(): AsyncIterable<string> {
		yield `${linuxOnlyMessage}\n`;
	}
}

/** Android/Termux and macOS service support are intentionally deferred. */
export function selectServiceManager(
	options: {
		platform?: NodeJS.Platform;
		env?: NodeJS.ProcessEnv;
		home?: string;
	} = {},
): ServiceManager {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (platform === "linux" && !env.TERMUX_VERSION)
		return new SystemdUserServiceManager({ home: options.home });
	return new UnsupportedServiceManager();
}

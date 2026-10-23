import { serve } from "@hono/node-server";
import { ensureConsoleConfig, initializePushStores } from "./registry.ts";
import { createConsoleApp, seedLocalDevices } from "./routes.ts";

export function startConsole() {
	const config = ensureConsoleConfig();
	initializePushStores();
	const { app, monitor } = createConsoleApp({ devices: seedLocalDevices() });
	void monitor.checkAll();
	return serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port });
}

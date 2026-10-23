import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createToken } from "../api/tokens.ts";
import { assignedPort } from "../steward/main.ts";
import { loadMachine } from "../config/load.ts";
import { consoleGuard } from "./guard.ts";
import { DeviceMonitor } from "./monitor.ts";
import { StreamMux } from "./mux.ts";
import { proxyDaemon } from "./proxy.ts";
import {
	type ConsoleDevice,
	loadConsoleConfig,
	loadDevices,
	saveDevices,
} from "./registry.ts";

const webRoot = fileURLToPath(new URL("../../web", import.meta.url));
const types: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
};

export function seedLocalDevices(): ConsoleDevice[] {
	const current = loadDevices();
	const machine = loadMachine();
	for (const assignment of machine.agents) {
		const agent = typeof assignment === "string" ? assignment : assignment.id;
		if (current.some((device) => device.id === agent)) continue;
		current.push({
			id: agent,
			url: `http://127.0.0.1:${assignedPort(agent)}`,
			token: createToken(agent, "console-local", ["read", "chat", "pause"]),
			agents: [agent],
		});
	}
	saveDevices(current);
	return current;
}

export function createConsoleApp(
	options: { devices?: ConsoleDevice[]; csrf?: string } = {},
) {
	const devices = options.devices ?? loadDevices();
	const config = loadConsoleConfig();
	const csrf = options.csrf ?? randomBytes(32).toString("base64url");
	const deviceMap = new Map(devices.map((device) => [device.id, device]));
	const monitor = new DeviceMonitor(devices);
	const mux = new StreamMux(deviceMap);
	const app = new Hono();
	app.use("*", consoleGuard(csrf, config));
	app.get("/api/bootstrap", async (c) =>
		c.json({ csrf, devices: await monitor.checkAll() }),
	);
	app.get("/api/devices", async (c) => c.json(await monitor.checkAll()));
	app.get("/api/stream", (c) => mux.open(c));
	app.put("/api/stream/:id", async (c) => {
		const body = await c.req.json<{ subs?: unknown }>();
		try {
			if (!mux.subscribe(c.req.param("id"), body.subs))
				return c.json({ error: "stream not found" }, 404);
		} catch (error) {
			return c.json({ error: String(error) }, 400);
		}
		return c.json({ ok: true });
	});
	app.all("/api/push/*", (c) =>
		c.json(
			{ error: { code: "not_enabled", message: "push is not enabled" } },
			501,
		),
	);
	app.all("/api/devices/:id/*", async (c) => {
		const device = deviceMap.get(c.req.param("id"));
		if (!device)
			return c.json(
				{ error: { code: "not_found", message: "device not found" } },
				404,
			);
		const suffix =
			c.req.path.replace(`/api/devices/${encodeURIComponent(device.id)}`, "") ||
			"/";
		return proxyDaemon(device, c.req.raw, suffix);
	});
	app.get("/*", async (c) => {
		const requested = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
		const path = normalize(join(webRoot, requested));
		if (!path.startsWith(`${webRoot}/`) && path !== join(webRoot, "index.html"))
			return c.notFound();
		try {
			return new Response(await readFile(path), {
				headers: {
					"content-type": types[extname(path)] ?? "application/octet-stream",
					"cache-control": "no-store",
				},
			});
		} catch {
			return c.notFound();
		}
	});
	return { app, monitor, mux, csrf };
}

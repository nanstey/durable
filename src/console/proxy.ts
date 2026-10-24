import type { ConsoleDevice } from "./registry.ts";

const readRoutes = [
	/^\/v1\/items(?:\/[^/?]+\/hold)?$/,
	/^\/v1\/(?:device|budget|queue|inbox|audit|conversations)(?:\/[^/?]+)?(?:\/(?:transcript|events))?$/,
	/^\/v1\/workers(?:\/[^/?]+)?$/,
	/^\/v1\/(?:events|sessions)(?:\/[^/?]+)?(?:\/(?:transcript|events))?$/,
	/^\/v1\/organizations\/[^/?]+\/bundle$/,
];
const approvalRoutes = [/^\/v1\/approvals\/(?:challenge|assert)$/];
const writeRoutes = [
	/^\/v1\/items\/[^/?]+\/hold(?:\/verify)?$/,
	/^\/v1\/conversations\/[^/?]+\/open$/,
	/^\/v1\/conversations$/,
	/^\/v1\/(?:conversations|sessions)\/[^/?]+\/(?:messages|abort)$/,
	/^\/v1\/messages$/,
	/^\/v1\/pause$/,
	/^\/v1\/inbox\/[^/?]+\/ack$/,
	/^\/v1\/workers\/[^/?]+\/(?:steer|interrupt)$/,
	/^\/v1\/organizations\/[^/?]+\/bundle$/,
];

export function allowedDaemonRoute(method: string, path: string) {
	return (
		method === "GET" || method === "HEAD"
			? readRoutes
			: [...writeRoutes, ...approvalRoutes]
	).some((route) => route.test(path));
}

export async function proxyDaemon(
	device: ConsoleDevice,
	request: Request,
	path: string,
) {
	if (!allowedDaemonRoute(request.method, path))
		return new Response(
			JSON.stringify({
				error: { code: "not_found", message: "console route not available" },
			}),
			{ status: 404, headers: { "content-type": "application/json" } },
		);
	const source = new URL(request.url);
	const destination = new URL(path + source.search, device.url);
	const headers = new Headers();
	// Approval assertions are a separate credential class. The daemon rejects bearer
	// credentials on these endpoints, so the console only relays the browser payload.
	if (!approvalRoutes.some((route) => route.test(path)))
		headers.set("authorization", `Bearer ${device.token}`);
	for (const name of ["content-type", "idempotency-key"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const response = await fetch(destination, {
		method: request.method,
		headers,
		body: ["GET", "HEAD"].includes(request.method)
			? undefined
			: await request.arrayBuffer(),
		signal: AbortSignal.timeout(30_000),
	});
	const output = new Headers(response.headers);
	output.delete("www-authenticate");
	output.delete("set-cookie");
	return new Response(response.body, {
		status: response.status,
		headers: output,
	});
}

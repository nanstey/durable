import type { MiddlewareHandler } from "hono";
import { authenticate, type Scope, type TokenRecord } from "./tokens.ts";
export type ApiEnv = { Variables: { actor: TokenRecord } };
function requiredScope(method: string, path: string): Scope | undefined {
	if (method === "GET") return "read";
	if (
		method === "POST" &&
		(/^\/v1\/workers\/[^/]+\/interrupt$/.test(path) || path === "/v1/pause")
	)
		return "pause";
	if (
		method === "POST" &&
		(/^\/v1\/(?:conversations|sessions)\/[^/]+\/(?:messages|abort)$/.test(
			path,
		) ||
			/^\/v1\/workers\/[^/]+\/steer$/.test(path) ||
			path === "/v1/messages" ||
			path === "/v1/conversations")
	)
		return "chat";
	// Acknowledging an inbox notice has no execution authority.
	if (method === "POST" && /^\/v1\/inbox\/[^/]+\/ack$/.test(path))
		return "read";
	return undefined;
}
export function auth(agent: string): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		if (c.req.path === "/healthz" && c.req.method === "GET") return next();
		const header = c.req.header("authorization");
		const proxyToken = c.req.header("x-durable-token");
		const token = header
			? header.startsWith("Bearer ")
				? header.slice(7)
				: undefined
			: proxyToken;
		const actor = header && proxyToken ? undefined : authenticate(agent, token);
		if (!actor)
			return c.json(
				{
					error: {
						code: "unauthorized",
						message: "valid bearer token required",
					},
				},
				401,
			);
		const scope = requiredScope(c.req.method, c.req.path);
		if (!scope || !actor.scopes.includes(scope))
			return c.json(
				{
					error: {
						code: "forbidden",
						message: "scope does not authorize this operation",
					},
				},
				403,
			);
		c.set("actor", actor);
		await next();
	};
}

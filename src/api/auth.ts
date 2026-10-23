import type { MiddlewareHandler } from "hono";
import { authenticate, type Scope, type TokenRecord } from "./tokens.ts";
export type ApiEnv = { Variables: { actor: TokenRecord } };
const writeScopes: Array<[Scope, RegExp[]]> = [
	[
		"pause",
		[
			/^\/v1\/workers\/[^/]+\/interrupt$/,
			/^\/v1\/items\/[^/]+\/(?:hold(?:\/verify)?|release\/request)$/,
			/^\/v1\/gate\/[^/]+\/approve\/request$/,
			/^\/v1\/(?:workers\/stop|pause)$/,
		],
	],
	[
		"chat",
		[
			/^\/v1\/(?:conversations|sessions)\/[^/]+\/(?:messages|abort)$/,
			/^\/v1\/workers\/[^/]+\/steer$/,
			/^\/v1\/items\/[^/]+\/retry$/,
			/^\/v1\/(?:messages|conversations)$/,
		],
	],
	["read", [/^\/v1\/conversations\/[^/]+\/open$/, /^\/v1\/inbox\/[^/]+\/ack$/]],
	["sync", [/^\/v1\/organizations\/[^/]+\/bundle$/]],
];
function requiredScope(method: string, path: string): Scope | undefined {
	if (method === "GET") return "read";
	if (method !== "POST") return undefined;
	return writeScopes.find(([, patterns]) =>
		patterns.some((pattern) => pattern.test(path)),
	)?.[0];
}
export function auth(agent: string): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		if (c.req.path === "/healthz" && c.req.method === "GET") return next();
		// Approval routes accept only an action-bound nonce, never a bearer credential.
		if (
			c.req.method === "POST" &&
			(/^\/v1\/items\/[^/]+\/release$/.test(c.req.path) ||
				c.req.path === "/v1/approvals/nonce" ||
				c.req.path === "/v1/approvals/challenge" ||
				c.req.path === "/v1/approvals/assert")
		) {
			if (c.req.header("authorization") || c.req.header("x-durable-token"))
				return c.json(
					{
						error: {
							code: "forbidden",
							message: "bearer credentials cannot authorize approvals",
						},
					},
					403,
				);
			return next();
		}
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

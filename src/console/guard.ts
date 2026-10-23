import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const csp =
	"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'";
function equal(left: string | undefined, right: string) {
	if (!left) return false;
	const a = Buffer.from(left),
		b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}
export function consoleGuard(
	csrf: string,
	options: { serveHostname?: string; allowedUsers?: string[] } = {},
): MiddlewareHandler {
	return async (context, next) => {
		context.header("Content-Security-Policy", csp);
		context.header("X-Content-Type-Options", "nosniff");
		context.header("Referrer-Policy", "no-referrer");
		const host = context.req.header("host") ?? "";
		const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
		const serve = Boolean(
			options.serveHostname && host === options.serveHostname,
		);
		if (!local && !serve) return context.text("invalid host", 421);
		if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
			const origin = context.req.header("origin");
			if (!origin || new URL(origin).host !== host)
				return context.text("cross-origin request refused", 403);
			if (
				!context.req
					.header("content-type")
					?.toLowerCase()
					.startsWith("application/json")
			)
				return context.text("JSON required", 415);
			if (!equal(context.req.header("x-durable-csrf"), csrf))
				return context.text("CSRF token required", 403);
			if (
				serve &&
				!options.allowedUsers?.includes(
					context.req.header("tailscale-user-login") ?? "",
				)
			)
				return context.text("Serve identity refused", 403);
		}
		await next();
	};
}

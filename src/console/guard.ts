import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const csp =
	"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'";

function equal(left: string | undefined, right: string) {
	if (!left) return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function consoleGuard(csrf: string): MiddlewareHandler {
	return async (context, next) => {
		context.header("Content-Security-Policy", csp);
		context.header("X-Content-Type-Options", "nosniff");
		context.header("Referrer-Policy", "no-referrer");
		const host = context.req.header("host") ?? "";
		if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
			return context.text("invalid host", 421);
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
		}
		await next();
	};
}

import { serve } from "@hono/node-server";
import { loopbackBind } from "./net.ts";
import { createApi } from "./routes.ts";

export function startApi(
	opts: Parameters<typeof createApi>[0] & { port: number; bind?: string },
) {
	const app = createApi(opts);
	return serve({
		fetch: app.fetch,
		hostname: loopbackBind(opts.bind),
		port: opts.port,
	});
}

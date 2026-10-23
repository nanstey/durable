import { serve } from "@hono/node-server";
import { tailnetAddress, loopbackBind } from "./net.ts";
import { createApi } from "./routes.ts";

export async function startApi(
	opts: Parameters<typeof createApi>[0] & {
		port: number;
		bind?: "loopback" | "tailnet";
		tailnetAddress?: string;
		peerCheckMode?: "required" | "optional" | "off";
		allowedPeers?: string[];
	},
) {
	const local = serve({
		fetch: createApi(opts).fetch,
		hostname: loopbackBind(),
		port: opts.port,
	});
	if (opts.bind !== "tailnet") return local;
	const mode = opts.peerCheckMode ?? "required";
	let address: string;
	try {
		address = await tailnetAddress(opts.tailnetAddress);
		if (mode === "required" && !opts.allowedPeers?.length)
			throw Error("network.allowedPeers is required with peerCheck required");
	} catch (error) {
		local.close();
		throw error;
	}
	const remote = serve({
		fetch: createApi({
			...opts,
			peerCheck: { mode, allowedPeers: opts.allowedPeers ?? [] },
		}).fetch,
		hostname: address,
		port: opts.port,
	});
	const close = local.close.bind(local);
	local.close = ((callback?: (error?: Error) => void) => {
		remote.close();
		return close(callback);
	}) as typeof local.close;
	return local;
}

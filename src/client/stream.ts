type StreamOptions = {
	signal?: AbortSignal;
	reconnectMs?: number;
	deadSocketMs?: number;
	fetcher?: typeof fetch;
};

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/** Reads our v1 SSE contract. Each fresh connection starts hello then snapshot. */
export async function* readEventStream<T>(
	url: string,
	token: string,
	options: StreamOptions = {},
): AsyncGenerator<T> {
	const fetcher = options.fetcher ?? fetch;
	const reconnectBase = options.reconnectMs ?? 1000;
	const deadSocketMs = options.deadSocketMs ?? 45_000;
	let retry = reconnectBase;
	while (!options.signal?.aborted) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			const response = await fetcher(url, {
				headers: {
					authorization: `Bearer ${token}`,
					accept: "text/event-stream",
				},
				signal: controller.signal,
			});
			if (!response.ok || !response.body)
				throw Error(`stream returned ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (!options.signal?.aborted) {
				const result = await Promise.race([
					reader.read(),
					sleep(deadSocketMs).then(() => ({ done: true, value: undefined })),
				]);
				if (result.done) break;
				buffer += decoder.decode(result.value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const data = [...block.matchAll(/^data: ?(.*)$/gm)]
						.map((match) => match[1])
						.join("\n");
					if (data) yield JSON.parse(data) as T;
					boundary = buffer.indexOf("\n\n");
				}
			}
			retry = reconnectBase;
		} catch {
			if (options.signal?.aborted) return;
		} finally {
			options.signal?.removeEventListener("abort", abort);
			controller.abort();
		}
		await sleep(retry, options.signal);
		retry = Math.min(retry * 2, 30_000);
	}
}

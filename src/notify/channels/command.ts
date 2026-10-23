import { execa } from "execa";
import type { NotifyEvent, NotifyPayload } from "../types.ts";

export async function deliverCommand(
	argv: string[],
	payload: NotifyPayload,
	event: NotifyEvent,
): Promise<void> {
	if (!argv.length) throw Error("command notification requires argv");
	await execa(argv[0], argv.slice(1), {
		input: JSON.stringify({
			...payload,
			...(event.nonce ? { nonce: event.nonce } : {}),
		}),
		reject: true,
		timeout: 15000,
	});
}

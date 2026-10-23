import { execa } from "execa";
import type { NotifyPayload } from "../notify/types.ts";

export type DesktopNotice = NotifyPayload & { nonce?: string };
export interface DesktopNotifier {
	readonly nonceSafe: boolean;
	notify(event: DesktopNotice): Promise<void>;
}

/** Linux desktop backend. notify-send never exposes the body to other local processes. */
export class NotifySendNotifier implements DesktopNotifier {
	readonly nonceSafe = true;
	async notify(event: DesktopNotice): Promise<void> {
		const body = [event.event, event.target, event.sha, event.nonce]
			.filter(Boolean)
			.join("\n");
		await execa("notify-send", [event.title ?? "Durable", body], {
			reject: true,
			timeout: 15000,
		});
	}
}

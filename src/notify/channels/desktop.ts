import type { DesktopNotifier } from "../../platform/notifier.ts";
import type { NotifyEvent, NotifyPayload } from "../types.ts";

export async function deliverDesktop(
	notifier: DesktopNotifier,
	payload: NotifyPayload,
	event: NotifyEvent,
): Promise<void> {
	await notifier.notify({
		...payload,
		...(notifier.nonceSafe && event.nonce ? { nonce: event.nonce } : {}),
	});
}

import { Notifier } from "../notify/notifier.ts";
import { eventNames, type NotifyEventName } from "../notify/types.ts";

function eventName(value: string): NotifyEventName {
	if (!(eventNames as readonly string[]).includes(value))
		throw Error(`unknown notification event: ${value}`);
	return value as NotifyEventName;
}
export async function notifyCommand(options: {
	agent: string;
	event?: string;
	test?: string;
	status?: boolean;
	json?: boolean;
}) {
	const notifier = new Notifier({ agent: options.agent });
	if (options.status) {
		const result = notifier.status();
		console.log(
			options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2),
		);
		return;
	}
	const name = options.test ?? options.event;
	if (!name) throw Error("--event or --test is required");
	const result = await notifier.notify({
		agent: options.agent,
		event: eventName(name),
		title: options.test ? "Durable notification test" : undefined,
	});
	console.log(options.json ? JSON.stringify({ result }) : result);
}

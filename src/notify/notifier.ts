import { join } from "node:path";
import { loadAgent, loadMachine } from "../config/load.ts";
import type {
	AgentDef,
	MachineCfg,
	ProfileManifest,
} from "../config/schema.ts";
import { resolveProfile } from "../identity/profiles.ts";
import {
	type DesktopNotifier,
	NotifySendNotifier,
} from "../platform/notifier.ts";
import { audit } from "../steward/audit.ts";
import { agentDir, loadJson, saveJson } from "../steward/files.ts";
import { deliverCommand } from "./channels/command.ts";
import { deliverDesktop } from "./channels/desktop.ts";
import { deliverGithub } from "./channels/github.ts";
import { type InboxChannel, machineInbox } from "./channels/inbox.ts";
import {
	dedupKey,
	type NotifyEvent,
	type NotifyPayload,
	type NotifyRule,
	redactedPayload,
} from "./types.ts";

type Pending = {
	payload: NotifyPayload;
	due: number;
	rule: NotifyRule;
	reminders: number;
};
type NotifyState = {
	dedup: Record<string, number>;
	held: Pending[];
	reminders: Pending[];
};
const empty = (): NotifyState => ({ dedup: {}, held: [], reminders: [] });
const statePath = (agent: string) =>
	join(agentDir(agent), "steward.notify.json");

function rule(
	definition: AgentDef,
	event: NotifyEvent,
): NotifyRule | undefined {
	const configured = definition.notify?.[event.event];
	if (!configured || typeof configured === "number") return undefined;
	if (Array.isArray(configured))
		return { channels: configured, priority: event.priority ?? "normal" };
	const reminders = configured.reminders;
	return {
		channels: configured.channels,
		priority: (configured.priority ??
			event.priority ??
			"normal") as NotifyRule["priority"],
		...(reminders?.afterMinutes !== undefined &&
		reminders.everyMinutes !== undefined &&
		reminders.max !== undefined
			? {
					reminders: {
						afterMinutes: reminders.afterMinutes,
						everyMinutes: reminders.everyMinutes,
						max: reminders.max,
					},
				}
			: {}),
	};
}
function expired(state: NotifyState, now: number) {
	for (const [key, until] of Object.entries(state.dedup))
		if (until <= now) delete state.dedup[key];
}

export type NotifierOptions = {
	agent: string;
	definition?: AgentDef;
	machine?: MachineCfg;
	now?: () => number;
	dedupTtlMs?: number;
	desktop?: DesktopNotifier;
	inbox?: InboxChannel;
	profileLogin?: string;
};
export class Notifier {
	private readonly options: NotifierOptions;
	private readonly now: () => number;
	private readonly ttl: number;
	private readonly definition: AgentDef;
	private readonly machine: MachineCfg;
	private readonly desktop: DesktopNotifier;
	private readonly inbox: InboxChannel;
	private readonly login?: string;
	constructor(options: NotifierOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.ttl = options.dedupTtlMs ?? 24 * 60 * 60 * 1000;
		this.definition = options.definition ?? loadAgent(options.agent);
		this.machine = options.machine ?? loadMachine();
		this.desktop = options.desktop ?? new NotifySendNotifier();
		this.inbox = options.inbox ?? machineInbox;
		this.login = options.profileLogin ?? this.profileLogin();
	}
	private profileLogin(): string | undefined {
		try {
			return loadJson<ProfileManifest | undefined>(
				resolveProfile(this.definition.profile).manifestFile,
				() => undefined,
			)?.github.login;
		} catch {
			return undefined;
		}
	}
	private state(): NotifyState {
		return loadJson(statePath(this.options.agent), empty);
	}
	private save(state: NotifyState) {
		saveJson(statePath(this.options.agent), state);
	}
	async notify(event: NotifyEvent): Promise<"sent" | "deduplicated" | "held"> {
		if (event.agent !== this.options.agent)
			throw Error("notification agent mismatch");
		const current = this.now();
		const state = this.state();
		expired(state, current);
		const payload = redactedPayload(event);
		const key = dedupKey(payload);
		if (state.dedup[key] && state.dedup[key] > current) {
			this.save(state);
			return "deduplicated";
		}
		const configured = rule(this.definition, event);
		if (!configured) return "sent";
		state.dedup[key] = current + this.ttl;
		const pending = { payload, due: current, rule: configured, reminders: 0 };
		if (this.quiet(current)) {
			state.held.push(pending);
			this.save(state);
			return "held";
		}
		await this.send(pending, event.nonce);
		this.scheduleReminder(state, pending, current);
		this.save(state);
		return "sent";
	}
	async due(): Promise<void> {
		const now = this.now();
		const state = this.state();
		expired(state, now);
		if (!this.quiet(now)) {
			for (const held of state.held.splice(0)) {
				await this.send(held);
				this.scheduleReminder(state, held, now);
			}
			const remaining: Pending[] = [];
			const dueReminders = state.reminders;
			state.reminders = remaining;
			for (const reminder of dueReminders) {
				if (reminder.due > now) state.reminders.push(reminder);
				else {
					await this.send(reminder);
					this.scheduleReminder(state, reminder, now);
				}
			}
		}
		this.save(state);
	}
	status(): NotifyState {
		return this.state();
	}
	private quiet(now: number): boolean {
		const spec = this.definition.schedule?.quietHours;
		if (!spec) return false;
		// Lazy import would complicate deterministic construction; same HH:MM semantics as kill switch.
		const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})(?: (UTC|local))?$/.exec(
			spec,
		);
		if (!match) throw Error("quietHours must be HH:MM-HH:MM [UTC|local]");
		const date = new Date(now);
		const minutes = (hour: string, minute: string) =>
			Number(hour) * 60 + Number(minute);
		const [start, end] = [
			minutes(match[1], match[2]),
			minutes(match[3], match[4]),
		];
		const value =
			match[5] === "UTC"
				? date.getUTCHours() * 60 + date.getUTCMinutes()
				: date.getHours() * 60 + date.getMinutes();
		return (
			start === end ||
			(start < end
				? value >= start && value < end
				: value >= start || value < end)
		);
	}
	private scheduleReminder(state: NotifyState, pending: Pending, now: number) {
		const policy = pending.rule.reminders;
		if (!policy || pending.reminders >= policy.max) return;
		state.reminders.push({
			...pending,
			due:
				now +
				(pending.reminders ? policy.everyMinutes : policy.afterMinutes) * 60000,
			reminders: pending.reminders + 1,
		});
	}
	private async send(pending: Pending, nonce?: string) {
		for (const name of pending.rule.channels) {
			const channel = this.machine.channels?.[name];
			if (!channel) throw Error(`unknown notification channel: ${name}`);
			try {
				if (channel.kind === "inbox" || channel.kind === "console")
					await this.inbox(pending.payload);
				else if (channel.kind === "desktop")
					await deliverDesktop(this.desktop, pending.payload, {
						...pending.payload,
						nonce,
					});
				else if (channel.kind === "command")
					await deliverCommand(channel.argv ?? [], pending.payload, {
						...pending.payload,
						nonce,
					});
				else if (channel.kind === "github") {
					const result = await deliverGithub(
						pending.payload,
						channel.targetLogin ?? "",
						this.login,
					);
					if (result === "skipped-self")
						audit(this.options.agent, {
							event: "notify-github-skipped-self",
							target: pending.payload.target,
						});
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					audit(this.options.agent, {
						event: "notify-channel-unavailable",
						channel: name,
					});
				else throw error;
			}
		}
	}
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	Containment,
	Invocation,
	Launch,
} from "../platform/containment.ts";
import { audit } from "./audit.ts";
import { agentDir, loadJson, saveJson } from "./files.ts";
import { queueInbox } from "./inbox.ts";
import { disabled } from "./killswitch.ts";

type Fence = {
	state: "holding" | "held" | "recovery";
	holdEpoch: number;
};
type ProcJournal = {
	invocations: Invocation[];
	holds: Record<string, Fence>;
};
export type FaultHook = (
	boundary: string,
	record: Invocation,
) => void | Promise<void>;
export class ProcessManager {
	private path: string;
	private journal: ProcJournal;
	private active = new Map<
		string,
		{ record: Invocation; cancelled: boolean }
	>();
	readonly agent: string;
	private backend: Containment;
	private fault: FaultHook;
	private quiet?: string;
	constructor(
		agent: string,
		backend: Containment,
		fault: FaultHook = () => {},
		quiet?: string,
	) {
		this.agent = agent;
		this.backend = backend;
		this.fault = fault;
		this.quiet = quiet;
		this.path = join(agentDir(agent), "procs.json");
		this.journal = loadJson(this.path, () => ({ invocations: [], holds: {} }));
	}
	fenced(item?: string) {
		return Boolean(item && this.journal.holds[item]);
	}
	snapshot() {
		return structuredClone(this.journal);
	}
	private async persist(
		record: Invocation,
		action: string,
		change: () => void,
	) {
		await this.fault(`before:${action}`, record);
		change();
		saveJson(this.path, this.journal);
		await this.fault(`after:${action}`, record);
	}
	private async cleanup(record: Invocation) {
		const active = this.active.get(record.invocationId);
		if (active) active.cancelled = true;
		await this.fault("before:kill", record);
		audit(this.agent, {
			event: "process-kill",
			invocationId: record.invocationId,
			state: record.state,
			item: record.item,
		});
		const empty = await this.backend.kill(record);
		await this.fault("after:kill", record);
		if (empty && this.backend.confirmed) {
			await this.persist(record, "delete", () => {
				this.journal.invocations = this.journal.invocations.filter(
					(r) => r.invocationId !== record.invocationId,
				);
			});
			return true;
		}
		if (record.item)
			this.journal.holds[record.item] = {
				state: "recovery",
				holdEpoch: (this.journal.holds[record.item]?.holdEpoch ?? 0) + 1,
			};
		saveJson(this.path, this.journal);
		queueInbox(this.agent, "escalation");
		audit(this.agent, {
			event: "escalation",
			reason: "containment-unconfirmed",
			item: record.item,
			invocationId: record.invocationId,
		});
		return false;
	}
	/** Must finish before opening a scheduler, even for records still in intent. */
	async sweep() {
		let clean = true;
		for (const record of [...this.journal.invocations])
			if (!(await this.cleanup(record))) clean = false;
		return clean;
	}
	async terminate(
		filter: { item?: string; attemptId?: string; task?: string } = {},
	) {
		let clean = true;
		// Cancel even launches that are waiting immediately before their intent commit.
		for (const active of this.active.values())
			if (matches(active.record, filter)) active.cancelled = true;
		for (const record of [...this.journal.invocations]) {
			if (matches(record, filter) && !(await this.cleanup(record)))
				clean = false;
		}
		return clean;
	}
	async launch(
		argv: string[],
		env: NodeJS.ProcessEnv,
		opts: {
			item?: string;
			attemptId?: string;
			task?: string;
			allowWhenDisabled?: boolean;
		} = {},
	) {
		if (!argv.length || this.fenced(opts.item))
			throw Error("invocation refused: item fenced or empty command");
		const executable = resolveExecutable(argv[0], env.PATH ?? "");
		const invocationId = randomUUID();
		const attemptId = opts.attemptId ?? "steward";
		// Hash untrusted item/attempt labels; names are deterministic from the durable intent.
		const label = createHash("sha256")
			.update(`${this.agent}:${opts.item ?? "steward"}:${attemptId}`)
			.digest("hex")
			.slice(0, 20);
		const record: Invocation = {
			invocationId,
			attemptId,
			item: opts.item,
			task: opts.task,
			unit: `durable-${label}-${invocationId}.scope`,
			slice: `durable-${label}.slice`,
			marker: invocationId,
			state: "intent",
		};
		const token = randomBytes(32).toString("hex");
		const active = { record, cancelled: false };
		this.active.set(invocationId, active);
		const assertAllowed = () => {
			if (
				active.cancelled ||
				this.fenced(opts.item) ||
				(!opts.allowWhenDisabled && disabled(this.agent, this.quiet))
			)
				throw Error("invocation refused: cancelled, disabled or item fenced");
		};
		let launch: Launch | undefined;
		try {
			assertAllowed();
			await this.persist(record, "intent", () =>
				this.journal.invocations.push(record),
			);
			await this.fault("before:spawn", record);
			assertAllowed();
			launch = this.backend.spawn(
				record,
				createHash("sha256").update(token).digest("hex"),
				[executable, ...argv.slice(1)],
				env,
			);
			await this.fault("after:spawn", record);
			const identity = await launch.identity;
			assertAllowed();
			await this.persist(record, "registered", () => {
				Object.assign(record, identity, { state: "registered" });
			});
			await this.persist(record, "releasing", () => {
				record.state = "releasing";
			});
			await this.fault("before:token-write", record);
			assertAllowed();
			const release = launch.release;
			await new Promise<void>((resolve, reject) =>
				release.end(`${token}\n`, (error?: Error | null) =>
					error ? reject(error) : resolve(),
				),
			);
			await this.fault("after:token-write", record);
			await this.persist(record, "running", () => {
				record.state = "running";
			});
			const result = await launch.done;
			if ((await this.backend.empty(record)) && this.backend.confirmed)
				await this.persist(record, "delete", () => {
					this.journal.invocations = this.journal.invocations.filter(
						(r) => r.invocationId !== invocationId,
					);
				});
			return result;
		} catch (error) {
			launch?.release.destroy();
			await this.cleanup(record);
			throw error;
		} finally {
			this.active.delete(invocationId);
		}
	}
}
function matches(
	record: Invocation,
	filter: { item?: string; attemptId?: string; task?: string },
) {
	return Object.entries(filter).every(
		([key, value]) => record[key as keyof Invocation] === value,
	);
}
function resolveExecutable(command: string, path: string) {
	const choices = isAbsolute(command)
		? [command]
		: path
				.split(":")
				.filter(Boolean)
				.map((dir) => join(dir, command));
	for (const candidate of choices) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* Try the next PATH entry. */
		}
	}
	throw Error("executable not found in explicit environment");
}

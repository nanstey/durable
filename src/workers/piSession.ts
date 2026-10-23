import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launcherScript, writeLauncher } from "../dispatch/launcher.ts";
import type { WorkerDispatcher } from "../dispatch/types.ts";
import type {
	JobSpec,
	WorkerCapabilities,
	WorkerHandle,
	WorkerKind,
} from "./kind.ts";

export class PiSessionKind implements WorkerKind {
	readonly name = "pi-session" as const;
	private readonly dispatcher: WorkerDispatcher;
	private readonly launcherRoot: string;
	constructor(dispatcher: WorkerDispatcher, launcherRoot: string) {
		this.dispatcher = dispatcher;
		this.launcherRoot = launcherRoot;
	}
	async start(job: JobSpec): Promise<WorkerHandle> {
		const env = {
			...job.env,
			DURABLE_WORKER: "1",
			DURABLE_AGENT: job.agent,
			DURABLE_ITEM: job.item,
			...(job.piDir ? { PI_CODING_AGENT_DIR: job.piDir } : {}),
		};
		const dir = join(this.launcherRoot, job.id);
		const brief = join(dir, "brief.md");
		const script = writeLauncher(
			dir,
			launcherScript({
				path: dir,
				briefPath: brief,
				env,
				model: job.model,
				headless: this.dispatcher.capabilities().attach !== "interactive",
			}),
		);
		// Write the brief after creating its private directory; it is always supplied by value.
		await import("node:fs/promises").then(({ writeFile }) =>
			writeFile(brief, job.briefText, { mode: 0o600 }),
		);
		const process = await this.dispatcher.hostProcess({
			id: job.id,
			workspace: job.workspace,
			command: script,
			env,
			title: `durable:${job.agent}/${job.item}`,
			headless: this.dispatcher.capabilities().attach !== "interactive",
		});
		return { id: job.id, job, process, startedAt: Date.now() };
	}
	async status(handle: WorkerHandle) {
		return this.dispatcher.processStatus(handle.process);
	}
	async result(handle: WorkerHandle) {
		return { status: await this.status(handle) };
	}
	async interrupt(handle: WorkerHandle, mode: "soft" | "hard") {
		await this.dispatcher.interruptProcess(handle.process, mode);
	}
	async steer(handle: WorkerHandle, text: string) {
		if (!this.dispatcher.capabilities().steer || !this.dispatcher.sendInput)
			throw Object.assign(Error("steer not supported"), {
				code: "not_supported",
			});
		await this.dispatcher.sendInput(handle.process, text);
	}
	async *transcript(handle: WorkerHandle): AsyncIterable<string> {
		if (!handle.job.piDir) return;
		const sessions = join(handle.job.piDir, "sessions");
		if (!existsSync(sessions)) return;
		for (const file of readdirSync(sessions)
			.filter((name) => name.endsWith(".jsonl"))
			.sort()) {
			const text = readFileSync(join(sessions, file), "utf8");
			for (const line of text.split(/\r?\n/)) if (line) yield line;
		}
	}
	async resume(handle: WorkerHandle): Promise<WorkerHandle> {
		const job = { ...handle.job, id: `${handle.id}-resume` };
		return this.start(job);
	}
	describe(handle: WorkerHandle) {
		return {
			id: handle.id,
			item: handle.job.item,
			workspace: handle.job.workspace.path,
			startedAt: handle.startedAt,
		};
	}
	capabilities(): WorkerCapabilities {
		const dispatcher = this.dispatcher.capabilities();
		return {
			attach: dispatcher.attach === "none" ? "read" : dispatcher.attach,
			steer: dispatcher.steer,
			transcript: true,
			interrupt: true,
			resumeAfterCrash: false,
			skills: "full",
			extensions: true,
			anthropicOAuth: "extension",
			headless: false,
			processIsolated: true,
			tokenInShell: true,
			viewable: "terminal",
		};
	}
}

import { readFile } from "node:fs/promises";
import { familyFor, providerFor } from "../config/agent.ts";
import type { AgentDef, MachineCfg, ModelDef } from "../config/schema.ts";
import type { WorkspaceSpec } from "../dispatch/types.ts";
import {
	type ModelProvenance,
	parseReviewResult,
	type ReviewResult,
} from "../workers/durable/review.ts";
import type { WorkerRegistry } from "../workers/registry.ts";
import { selectWorkerKind } from "../workers/select.ts";

export type StewardReview = {
	sha: string;
	result: ReviewResult;
	provenance: ModelProvenance;
};
export type ReviewerLaunch = {
	id: string;
	agent: string;
	item: string;
	repo: string;
	baseRef: string;
	headSha: string;
	pr: number;
	producer: ModelDef;
	workspace: WorkspaceSpec;
	briefText: string;
	outputFile: string;
	env: Record<string, string | undefined>;
	limits: Record<string, number>;
};
export type RunningReview = ReviewerLaunch & {
	kind: "pi-session" | "durable-conversation";
};

// fallow-ignore-next-line unused-export
export function reviewerModel(definition: AgentDef): ModelDef {
	const reviewer = definition.models?.reviewer;
	if (!reviewer || reviewer === "auto")
		throw Error("reviewer model must be explicitly resolved before launch");
	const worker = definition.models?.worker;
	if (!worker || familyFor(worker) === familyFor(reviewer))
		throw Error("reviewer model family is not independent");
	return reviewer;
}

/** Launch a reviewer through the same dispatcher and kind registry as workers. */
export async function launchReviewer(
	definition: AgentDef,
	machine: MachineCfg,
	workers: WorkerRegistry,
	dispatcher: import("../dispatch/types.ts").WorkerDispatcher,
	kinds: import("../workers/kind.ts").WorkerKindRegistry,
	input: ReviewerLaunch,
): Promise<RunningReview> {
	const model = reviewerModel(definition);
	const kind = selectWorkerKind(kinds, definition, machine, "reviewer");
	await workers.launch(dispatcher, kind, {
		id: input.id,
		agent: input.agent,
		item: input.item,
		repo: input.repo,
		baseRef: input.baseRef,
		reviewedHeadSha: input.headSha,
		reviewedPr: input.pr,
		reviewedFamily: familyFor(input.producer),
		role: "reviewer",
		briefText: input.briefText,
		workspace: input.workspace,
		model,
		limits: input.limits,
		env: {
			...input.env,
			DURABLE_REVIEWER: "1",
			DURABLE_REVIEW_RESULT_FILE: input.outputFile,
		},
	});
	return { ...input, kind: kind.name };
}

type AssistantEntry = { provider?: string; model?: string; family?: string };
function assistantEntries(line: string): AssistantEntry[] {
	try {
		const value = JSON.parse(line) as unknown;
		const found: AssistantEntry[] = [];
		const visit = (node: unknown): void => {
			if (!node || typeof node !== "object") return;
			const record = node as Record<string, unknown>;
			const role =
				record.role ??
				(record.message as Record<string, unknown> | undefined)?.role;
			if (role === "assistant") {
				const message = (record.message ?? record) as Record<string, unknown>;
				found.push({
					provider:
						typeof message.provider === "string" ? message.provider : undefined,
					model: typeof message.model === "string" ? message.model : undefined,
					family:
						typeof message.family === "string" ? message.family : undefined,
				});
				return;
			}
			for (const child of Object.values(record)) visit(child);
		};
		visit(value);
		return found;
	} catch {
		return [];
	}
}

/** Validate a completed reviewer result and all successful assistant entries. */
export async function collectReview(
	running: RunningReview,
	workers: WorkerRegistry,
	definition: AgentDef,
): Promise<StewardReview> {
	const registered = await workers.get(running.id);
	const result = await registered.kind.result(registered.handle);
	const review =
		running.kind === "durable-conversation"
			? result.review
			: parseReviewResult(
					JSON.parse(await readFile(running.outputFile, "utf8")),
				);
	if (!review) throw Error("reviewer failed without a verdict");
	if (review.headSha !== running.headSha)
		throw Error("review verdict head SHA does not match reviewed head");
	const lines = await workers.transcript(running.id);
	const entries = lines.flatMap(assistantEntries);
	if (!entries.length)
		throw Error("reviewer provenance has no assistant entries");
	const expectedFamily = familyFor(running.producer);
	const model = reviewerModel(definition);
	const expected = {
		provider: providerFor(model),
		model: model.model,
		family: familyFor(model),
	};
	if (
		entries.some(
			(entry) =>
				(entry.family ??
					familyFor({ provider: entry.provider, model: entry.model ?? "" })) ===
				expectedFamily,
		)
	)
		throw Error("reviewer assistant entry is not an independent model family");
	return {
		sha: running.headSha,
		result: review,
		provenance: {
			...expected,
			entries: entries.length,
			source:
				running.kind === "durable-conversation"
					? "durable-entries"
					: "pi-session-log",
		},
	};
}

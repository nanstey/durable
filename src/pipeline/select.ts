import type { AgentDef } from "../config/schema.ts";

// fallow-ignore-next-line unused-export
export const pipelineStages = [
	"scout",
	"spec",
	"build",
	"review",
	"gate",
	"handoff",
] as const;
export type PipelineStage = (typeof pipelineStages)[number];
export type ProjectPipeline = {
	stages: PipelineStage[];
	gates: { specApproval?: boolean; complexityThreshold?: "medium" | "large" };
};

const required: PipelineStage[] = ["build", "review", "gate", "handoff"];
export const defaultPipeline: ProjectPipeline = {
	stages: ["scout", "build", "review", "gate", "handoff"],
	gates: {},
};

/** Validates the code-owned order; prompts never select or skip pipeline stages. */
export function selectPipeline(
	value?: Partial<ProjectPipeline>,
): ProjectPipeline {
	const stages = value?.stages ?? defaultPipeline.stages;
	const gates = value?.gates ?? {};
	if (
		!Array.isArray(stages) ||
		stages.some((stage) => !pipelineStages.includes(stage))
	)
		throw Error("pipeline has an unknown stage");
	if (new Set(stages).size !== stages.length)
		throw Error("pipeline stages must be unique");
	let previous = -1;
	for (const stage of stages) {
		const index = pipelineStages.indexOf(stage);
		if (index <= previous) throw Error("pipeline stages are out of order");
		previous = index;
	}
	for (const stage of required)
		if (!stages.includes(stage)) throw Error(`pipeline requires ${stage}`);
	if (stages.at(-1) !== "handoff") throw Error("pipeline handoff must be last");
	return { stages: [...stages], gates: { ...gates } };
}

export function pipelineFor(
	definition: AgentDef,
	repo: string,
): ProjectPipeline {
	return selectPipeline(
		definition.scope?.repos?.find((entry) => entry.slug === repo)?.pipeline,
	);
}

/** The optional spec stage is valid only when its code-owned threshold is declared. */
export function pipelineDoctorErrors(pipeline: ProjectPipeline): string[] {
	return pipeline.gates.specApproval && !pipeline.stages.includes("spec")
		? ["pipeline specApproval requires the spec stage"]
		: [];
}

export function nextStage(
	pipeline: ProjectPipeline,
	current?: PipelineStage,
): PipelineStage | undefined {
	if (!current) return pipeline.stages[0];
	const index = pipeline.stages.indexOf(current);
	if (index < 0) throw Error(`stage ${current} is not selected`);
	return pipeline.stages[index + 1];
}

import type { ModelDef } from "./schema.ts";

export function providerFor(model: ModelDef): string {
	return model.provider ?? model.model.split("/")[0];
}
export function familyFor(model: ModelDef): string {
	if (model.family) return model.family;
	if (/anthropic|claude/i.test(model.model)) return "anthropic";
	if (/openai|codex|gpt-/i.test(model.model)) return "openai";
	if (/google|gemini/i.test(model.model)) return "google";
	return providerFor(model).replace("-codex", "");
}
export function tighteningWarnings(
	tighten: Record<string, unknown>,
	policy: Record<string, unknown>,
): string[] {
	const warnings: string[] = [];
	for (const [key, value] of Object.entries(tighten)) {
		const baseline = policy[key];
		let loosens = false;
		if (typeof value === "boolean" && baseline === true && value === false)
			loosens = true;
		if (typeof value === "number" && typeof baseline === "number")
			loosens =
				key === "coolingOffMinutes" ? value < baseline : value > baseline;
		if (Array.isArray(value) && Array.isArray(baseline)) {
			const additive = key === "pathDeny" || key === "requiredChecks";
			loosens = additive
				? baseline.some((item) => !value.includes(item))
				: value.some((item) => !baseline.includes(item));
		}
		if (key === "maxRisk" && baseline === "low" && value === "medium")
			loosens = true;
		if (loosens)
			warnings.push(
				`tighten.${key} attempts to loosen resolved policy and must be clamped`,
			);
	}
	return warnings;
}

/** Generic routers are not proof of an opposite family without an explicit model. */
export function oppositeProvider(
	worker: ModelDef,
	providers: string[],
): string | undefined {
	return providers.find(
		(provider) =>
			["anthropic", "openai", "openai-codex", "google"].includes(provider) &&
			familyFor({ provider, model: provider }) !== familyFor(worker),
	);
}

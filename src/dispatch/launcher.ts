import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelDef } from "../config/schema.ts";

export function launcherScript(options: {
	path: string;
	briefPath: string;
	env: Record<string, string | undefined>;
	model: ModelDef;
	resume?: boolean;
	headless: boolean;
}): string {
	const provider =
		options.model.provider ?? options.model.model.split("/", 1)[0];
	const model = options.model.provider
		? options.model.model
		: options.model.model.split("/").slice(1).join("/");
	if (!provider || !model) throw Error("worker model needs provider and model");
	const env = Object.entries(options.env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
				throw Error("invalid worker environment key");
			return `${key}="\${${key}}"`;
		})
		.join(" ");
	const continueFlag = options.resume ? " --continue" : "";
	return `#!/bin/sh\nset -eu\ncd ${shellQuote(options.path)}\nexec env -i ${env} pi${continueFlag} --provider ${shellQuote(provider)} --model ${shellQuote(model)}${options.model.thinking ? ` --thinking ${shellQuote(options.model.thinking)}` : ""} "$(cat ${shellQuote(options.briefPath)})"${options.headless ? " < /dev/null" : ""}\n`;
}
export function writeLauncher(dir: string, script: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, "launch-worker.sh");
	writeFileSync(path, script, { mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

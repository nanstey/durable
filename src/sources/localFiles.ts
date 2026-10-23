import { glob, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "yaml";
import type { Candidate, Source } from "./types.ts";

export type LocalFilesOptions = {
	repo: string;
	checkout: string;
	pattern: string;
	statusField?: string;
	readyValue?: string;
};

function frontMatter(text: string): Record<string, unknown> {
	const match = /^---\s*\n([\s\S]*?)\n---(?:\s|$)/.exec(text);
	return match ? ((parse(match[1]) as Record<string, unknown>) ?? {}) : {};
}

async function insideCheckout(path: string, checkout: string) {
	const [file, root] = await Promise.all([realpath(path), realpath(checkout)]);
	return (
		relative(root, file) &&
		!relative(root, file).startsWith("..") &&
		!resolve(file).startsWith("..")
	);
}

export async function readLocalBody(
	candidate: Candidate,
	checkout: string,
): Promise<string> {
	if (
		!checkout ||
		candidate.kind !== "file" ||
		!candidate.bodyRef?.startsWith("file:")
	)
		throw Error("local intake body reference missing");
	const path = resolve(checkout, candidate.bodyRef.slice(5));
	if (!(await insideCheckout(path, checkout)))
		throw Error("local intake body escapes checkout");
	return readFile(path, "utf8");
}

export class LocalFilesSource implements Source {
	private readonly options: LocalFilesOptions;
	constructor(options: LocalFilesOptions) {
		this.options = options;
	}
	async poll(): Promise<Candidate[]> {
		const checkout = await realpath(this.options.checkout);
		const candidates: Candidate[] = [];
		for await (const entry of glob(this.options.pattern, {
			cwd: checkout,
			withFileTypes: true,
		})) {
			if (!entry.isFile()) continue;
			const path = resolve(checkout, entry.parentPath, entry.name);
			if (!(await insideCheckout(path, checkout))) continue;
			const text = await readFile(path, "utf8");
			const data = frontMatter(text);
			const status = data[this.options.statusField ?? "status"];
			if (
				this.options.readyValue !== undefined &&
				status !== this.options.readyValue
			)
				continue;
			const info = await stat(path);
			const local = relative(checkout, path);
			candidates.push({
				ref: `${this.options.repo}:${local}`,
				kind: "file",
				repo: this.options.repo,
				title: typeof data.title === "string" ? data.title : local,
				author: typeof data.author === "string" ? data.author : "local",
				authorAssociation: "OWNER",
				labels: Array.isArray(data.labels)
					? data.labels.filter((x): x is string => typeof x === "string")
					: [],
				updatedAt: info.mtime.toISOString(),
				bodyRef: `file:${local}`,
				state: typeof status === "string" ? status : undefined,
				size: typeof data.size === "number" ? data.size : undefined,
			});
		}
		return candidates;
	}
}

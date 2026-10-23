import { readdir, readFile, readlink } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Advisory only: cwd/files cannot detect a writer that will use an absolute path later. */
export async function workspaceWriters(
	workspace: string,
	proc = "/proc",
	uid = process.getuid?.(),
): Promise<number[]> {
	const root = resolve(workspace);
	const inside = (path: string) =>
		path === root || path.startsWith(`${root}${sep}`);
	const writers: number[] = [];
	for (const name of await readdir(proc)) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const base = `${proc}/${name}`;
			const status = await readFile(`${base}/status`, "utf8");
			if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
			const cwd = await readlink(`${base}/cwd`).catch(() => "");
			let found = inside(cwd);
			for (const fd of await readdir(`${base}/fd`).catch(() => [] as string[]))
				if (inside(await readlink(`${base}/fd/${fd}`).catch(() => "")))
					found = true;
			if (found) writers.push(Number(name));
		} catch {
			/* Exit/permission races are not proof of emptiness. */
		}
	}
	return writers;
}

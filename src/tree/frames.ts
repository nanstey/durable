import type { TreeNode } from "./nodes.ts";
export function treeDelta(previous: TreeNode[], current: TreeNode[]) {
	const old = new Map(previous.map((node) => [node.id, node]));
	const ids = new Set(current.map((node) => node.id));
	return {
		upsert: current.filter(
			(node) => JSON.stringify(old.get(node.id)) !== JSON.stringify(node),
		),
		remove: previous.filter((node) => !ids.has(node.id)).map((node) => node.id),
	};
}

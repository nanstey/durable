import React, { useEffect, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import type { DurableClient } from "../client/client.ts";
import type { TreeNode } from "../tree/nodes.ts";
import { transcriptLines } from "../client/transcript.ts";

function treeLines(nodes: readonly TreeNode[]) {
	const children = new Map<string | null, TreeNode[]>();
	for (const node of nodes) {
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
	const lines: Array<{ node: TreeNode; text: string }> = [];
	const visit = (parent: string | null, depth: number) => {
		for (const node of children.get(parent) ?? []) {
			lines.push({
				node,
				text: `${"  ".repeat(depth)}${node.kind} ${node.status}`,
			});
			visit(node.id, depth + 1);
		}
	};
	visit(null, 0);
	return lines;
}

function AttachApp({
	client,
	selected,
}: {
	client: DurableClient;
	selected?: string;
}) {
	const [nodes, setNodes] = useState<TreeNode[]>([]);
	const [current, setCurrent] = useState(selected);
	const [entries, setEntries] = useState<string[]>([]);
	const [draft, setDraft] = useState("");
	const [scopes, setScopes] = useState<string[]>([]);
	const [notice, setNotice] = useState("connecting");
	const lines = treeLines(nodes);
	const node =
		nodes.find((candidate) => candidate.id === current) ?? lines[0]?.node;

	useEffect(() => {
		void client.device().then((device) => setScopes(device.scopeSummary));
		const controller = new AbortController();
		void (async () => {
			for await (const frame of client.events(controller.signal)) {
				if (frame.type === "snapshot" || frame.type === "delta") {
					const state = frame.state as { nodes?: TreeNode[] };
					if (state.nodes) setNodes(state.nodes);
				}
				if (frame.type === "tree")
					setNodes((old) => [
						...old.filter(
							(item) =>
								!frame.remove.includes(item.id) &&
								!frame.upsert.some((next) => next.id === item.id),
						),
						...frame.upsert,
					]);
				setNotice("live");
			}
		})();
		return () => controller.abort();
	}, [client]);
	useEffect(() => {
		if (!node?.capabilities.transcript) return;
		void client
			.transcript(node.id)
			.then((value) =>
				setEntries(
					transcriptLines(value as Parameters<typeof transcriptLines>[0]),
				),
			);
	}, [client, node?.id, node?.capabilities.transcript]);
	useInput((input, key) => {
		if (
			key.return &&
			node?.capabilities.steer &&
			scopes.includes("chat") &&
			draft.trim()
		) {
			void client
				.message(
					node.id,
					draft,
					node.status === "running" ? "steer" : "followUp",
				)
				.then(() => {
					setDraft("");
					setNotice(
						node.status === "running" ? "steer sent" : "follow-up sent",
					);
				});
			return;
		}
		if (key.backspace || key.delete) {
			setDraft((value) => value.slice(0, -1));
			return;
		}
		if (
			!key.ctrl &&
			!key.meta &&
			input.length === 1 &&
			!key.upArrow &&
			!key.downArrow
		) {
			setDraft((value) => value + input);
			return;
		}
		if (key.upArrow || input === "k") {
			const index = lines.findIndex((line) => line.node.id === node?.id);
			setCurrent(lines[Math.max(0, index - 1)]?.node.id);
		}
		if (key.downArrow || input === "j") {
			const index = lines.findIndex((line) => line.node.id === node?.id);
			setCurrent(lines[Math.min(lines.length - 1, index + 1)]?.node.id);
		}
		if (key.escape && node?.capabilities.interrupt && scopes.includes("chat"))
			void client.abort(node.id).then(() => setNotice("abort sent"));
	});
	return React.createElement(
		Box,
		{ flexDirection: "column" },
		React.createElement(Text, null, `durable attach — ${notice}`),
		React.createElement(
			Text,
			null,
			"↑/↓ select · esc abort when permitted · enter sends · ctrl-c detach",
		),
		React.createElement(
			Box,
			{ flexDirection: "row" },
			React.createElement(
				Box,
				{ width: "35%", flexDirection: "column" },
				...lines.map((line) =>
					React.createElement(
						Text,
						{
							key: line.node.id,
							color: line.node.id === node?.id ? "cyan" : undefined,
						},
						`${line.node.id === node?.id ? "> " : "  "}${line.text}`,
					),
				),
			),
			React.createElement(
				Box,
				{ width: "65%", flexDirection: "column" },
				React.createElement(
					Text,
					null,
					node ? `Transcript: ${node.kind}` : "No conversations",
				),
				...entries
					.slice(-20)
					.map((line, index) =>
						React.createElement(Text, { key: `${index}:${line}` }, line),
					),
				React.createElement(
					Text,
					{
						color:
							node?.capabilities.steer && scopes.includes("chat")
								? "green"
								: "gray",
					},
					`> ${draft}`,
				),
			),
		),
	);
}

export async function attachTui(client: DurableClient, selected?: string) {
	const instance = render(React.createElement(AttachApp, { client, selected }));
	await instance.waitUntilExit();
}

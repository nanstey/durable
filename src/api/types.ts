import type { TreeNode } from "../tree/nodes.ts";
import type { Scope } from "./tokens.ts";
export type ErrorCode =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "invalid"
	| "busy"
	| "conflict"
	| "rate_limited"
	| "not_supported"
	| "unavailable"
	| "internal";
export type ErrorResponse = { error: { code: ErrorCode; message: string } };
export type Device = {
	apiVersion: "v1";
	durableVersion: string;
	uid: string;
	machine: string;
	agent: string;
	profile: string;
	scopeSummary: Scope[];
	capabilities: { tree: boolean; startableKinds: string[] };
	startedAt: number;
};
export type MessageRequest = {
	body: string;
	requestId: string;
	whenBusy: "steer" | "followUp" | "reject";
};
export type MessageResponse = { id: string };
export type StreamFrame =
	| { type: "hello"; apiVersion: "v1"; scope: string; serverTime: number }
	| { type: "snapshot" | "delta"; state: unknown }
	| { type: "tree"; upsert: TreeNode[]; remove: string[] };

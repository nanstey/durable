import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { durableHome } from "../config/paths.ts";
export type Message = {
	id: string;
	conversationId: string;
	body: string;
	at: number;
};
export type State = {
	uid: string;
	paused: boolean;
	startedAt: number;
	messages: Message[];
	requests: Record<string, unknown>;
	inbox: Array<{
		id: string;
		type: string;
		createdAt: number;
		acked?: boolean;
	}>;
};
const dir = (a: string) => join(durableHome(), "agents", a);
const path = (a: string) => join(dir(a), "state.json");
export function openState(agent: string): State {
	mkdirSync(dir(agent), { recursive: true, mode: 0o700 });
	if (existsSync(path(agent)))
		return JSON.parse(readFileSync(path(agent), "utf8")) as State;
	const s = {
		uid: randomUUID(),
		paused: false,
		startedAt: Date.now(),
		messages: [],
		requests: {},
		inbox: [],
	};
	saveState(agent, s);
	return s;
}
export function saveState(agent: string, s: State) {
	writeFileSync(path(agent), `${JSON.stringify(s)}\n`, { mode: 0o600 });
	chmodSync(path(agent), 0o600);
}
export function audit(agent: string, event: Record<string, unknown>) {
	const p = join(dir(agent), "audit.jsonl");
	appendFileSync(p, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}
export function transcript(s: State) {
	return s.messages.map((m) => ({
		role: "human",
		content: m.body,
		at: m.at,
		id: m.id,
	}));
}
export function addMessage(s: State, conversationId: string, body: string) {
	const m = { id: randomUUID(), conversationId, body, at: Date.now() };
	s.messages.push(m);
	return m;
}
export function digest(body: string) {
	return createHash("sha256").update(body).digest("hex");
}

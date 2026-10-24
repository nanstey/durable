import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir, loadJson, saveJson } from "../steward/files.ts";

export type ApprovalAction =
	| "approve"
	| "resume"
	| "enroll"
	| "verify-policy"
	| "release";
type Binding = string | number;
type Challenge = {
	action: ApprovalAction;
	item: string;
	binding: Binding;
	challenge: string;
	expiresAt: number;
	kind: "assertion" | "registration";
	secondEnrollment?: boolean;
};
type Key = {
	id: string;
	publicKey: string;
	counter: number;
	transports?: string[];
};
type Store = {
	keys: Key[];
	challenges: Record<string, Challenge>;
	enrollment?: { hash: string; expiresAt: number };
};

/** Daemon-owned WebAuthn state. Browser and console only relay options and responses. */
export class ApprovalWebAuthn {
	private readonly path: string;
	private readonly agent: string;
	private readonly config: { rpId: string; origin: string };
	private readonly now: () => number;
	private static readonly maxChallenges = 20;
	constructor(
		agent: string,
		config: { rpId: string; origin: string },
		now: () => number = Date.now,
	) {
		this.agent = agent;
		this.config = config;
		this.now = now;
		this.path = join(agentDir(agent), "approval", "webauthn.json");
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
	}
	private load(): Store {
		const state = loadJson<Store>(this.path, () => ({
			keys: [],
			challenges: {},
		}));
		for (const [id, challenge] of Object.entries(state.challenges))
			if (challenge.expiresAt <= this.now()) delete state.challenges[id];
		return state;
	}
	private save(state: Store) {
		saveJson(this.path, state);
	}
	private digest(code: string) {
		return createHash("sha256").update(code).digest("hex");
	}
	issueEnrollmentCode(): string {
		const state = this.load();
		const code = randomBytes(18).toString("base64url");
		state.enrollment = {
			hash: this.digest(code),
			expiresAt: this.now() + 5 * 60_000,
		};
		this.save(state);
		return code;
	}
	list() {
		return this.load().keys.map(({ id, counter }) => ({ id, counter }));
	}
	revoke(id: string) {
		const state = this.load();
		const before = state.keys.length;
		state.keys = state.keys.filter((key) => key.id !== id);
		this.save(state);
		return state.keys.length !== before;
	}
	private challenge(
		state: Store,
		action: ApprovalAction,
		item: string,
		binding: Binding,
		kind: Challenge["kind"],
		secondEnrollment = false,
	) {
		if (Object.keys(state.challenges).length >= ApprovalWebAuthn.maxChallenges)
			throw Object.assign(Error("too many pending passkey challenges"), {
				code: "rate_limited",
			});
		const id = randomBytes(18).toString("base64url");
		const challenge = randomBytes(32).toString("base64url");
		state.challenges[id] = {
			action,
			item,
			binding,
			challenge,
			expiresAt: this.now() + 2 * 60_000,
			kind,
			secondEnrollment,
		};
		return { id, challenge };
	}
	private async authenticationOptions(
		_state: Store,
		issued: { id: string; challenge: string },
	) {
		return {
			id: issued.id,
			kind: "assertion" as const,
			options: await generateAuthenticationOptions({
				rpID: this.config.rpId,
				challenge: Buffer.from(issued.challenge, "base64url"),
				// Discoverable credentials avoid exposing enrolled credential IDs to
				// callers of the deliberately unauthenticated challenge endpoint.
				allowCredentials: [],
				userVerification: "required",
			}),
		};
	}
	private async registrationOptions(
		state: Store,
		issued: { id: string; challenge: string },
	) {
		return {
			id: issued.id,
			kind: "registration" as const,
			options: await generateRegistrationOptions({
				rpName: "Durable",
				rpID: this.config.rpId,
				userName: this.agent,
				userID: new TextEncoder().encode(this.agent),
				challenge: Buffer.from(issued.challenge, "base64url"),
				excludeCredentials: state.keys.map((key) => ({ id: key.id })),
				authenticatorSelection: {
					residentKey: "preferred",
					userVerification: "required",
				},
			}),
		};
	}
	async options(
		action: ApprovalAction,
		item: string,
		binding: Binding,
		enrollmentCode?: string,
	) {
		const state = this.load();
		const enrollment = action === "enroll";
		if (enrollment && state.keys.length === 0) {
			const record = state.enrollment;
			const actual = enrollmentCode
				? Buffer.from(this.digest(enrollmentCode), "hex")
				: undefined;
			if (
				!record ||
				record.expiresAt <= this.now() ||
				!actual ||
				!timingSafeEqual(Buffer.from(record.hash, "hex"), actual)
			)
				throw Object.assign(
					Error("valid enrollment code required for first passkey"),
					{ code: "forbidden" },
				);
		}
		if (enrollment && state.keys.length > 0) {
			const issued = this.challenge(state, action, item, binding, "assertion");
			this.save(state);
			return this.authenticationOptions(state, issued);
		}
		const issued = this.challenge(
			state,
			action,
			item,
			binding,
			enrollment ? "registration" : "assertion",
		);
		this.save(state);
		if (enrollment) return this.registrationOptions(state, issued);
		return this.authenticationOptions(state, issued);
	}
	private take(
		state: Store,
		id: string,
		action: ApprovalAction,
		item: string,
		binding: Binding,
		kind: Challenge["kind"],
	) {
		const challenge = state.challenges[id];
		delete state.challenges[id];
		this.save(state);
		if (
			!challenge ||
			challenge.expiresAt <= this.now() ||
			challenge.action !== action ||
			challenge.item !== item ||
			challenge.binding !== binding ||
			challenge.kind !== kind
		)
			throw Object.assign(
				Error("invalid, expired, or mismatched passkey challenge"),
				{ code: "forbidden" },
			);
		return challenge;
	}
	async verifyAssertion(
		id: string,
		action: ApprovalAction,
		item: string,
		binding: Binding,
		response: AuthenticationResponseJSON,
	) {
		const state = this.load();
		const challenge = this.take(state, id, action, item, binding, "assertion");
		const key = state.keys.find((candidate) => candidate.id === response.id);
		if (!key)
			throw Object.assign(Error("passkey is not enrolled"), {
				code: "forbidden",
			});
		const verified = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge.challenge,
			expectedOrigin: this.config.origin,
			expectedRPID: this.config.rpId,
			credential: {
				id: key.id,
				publicKey: Buffer.from(key.publicKey, "base64url"),
				counter: key.counter,
				transports: key.transports as never,
			},
		});
		if (!verified.verified)
			throw Object.assign(Error("passkey assertion refused"), {
				code: "forbidden",
			});
		key.counter = verified.authenticationInfo.newCounter;
		this.save(state);
	}
	async verifyEnrollmentAssertion(
		id: string,
		response: AuthenticationResponseJSON,
	) {
		await this.verifyAssertion(id, "enroll", this.agent, "enroll", response);
		const state = this.load();
		const issued = this.challenge(
			state,
			"enroll",
			this.agent,
			"enroll",
			"registration",
			true,
		);
		this.save(state);
		return this.registrationOptions(state, issued);
	}
	async verifyEnrollment(id: string, response: RegistrationResponseJSON) {
		const state = this.load();
		const challenge = this.take(
			state,
			id,
			"enroll",
			this.agent,
			"enroll",
			"registration",
		);
		if (
			(challenge.secondEnrollment && state.keys.length === 0) ||
			(!challenge.secondEnrollment && state.keys.length > 0)
		)
			throw Object.assign(Error("passkey enrollment state changed"), {
				code: "forbidden",
			});
		const verified = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge.challenge,
			expectedOrigin: this.config.origin,
			expectedRPID: this.config.rpId,
			requireUserVerification: true,
		});
		if (!verified.verified)
			throw Object.assign(Error("passkey registration refused"), {
				code: "forbidden",
			});
		const credential = verified.registrationInfo.credential;
		state.keys.push({
			id: credential.id,
			publicKey: Buffer.from(credential.publicKey).toString("base64url"),
			counter: credential.counter,
			transports: response.response.transports,
		});
		if (!challenge.secondEnrollment) delete state.enrollment;
		this.save(state);
		return credential.id;
	}
}

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
	enroll?: boolean;
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
		enroll = false,
	) {
		const id = randomBytes(18).toString("base64url");
		const challenge = randomBytes(32).toString("base64url");
		state.challenges[id] = {
			action,
			item,
			binding,
			challenge,
			expiresAt: this.now() + 2 * 60_000,
			enroll,
		};
		return { id, challenge };
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
			delete state.enrollment;
		}
		const issued = this.challenge(state, action, item, binding, enrollment);
		this.save(state);
		if (enrollment)
			return {
				id: issued.id,
				options: await generateRegistrationOptions({
					rpName: "Durable",
					rpID: this.config.rpId,
					userName: this.agent,
					userID: new TextEncoder().encode(this.agent),
					challenge: issued.challenge,
					excludeCredentials: state.keys.map((key) => ({ id: key.id })),
					authenticatorSelection: {
						residentKey: "preferred",
						userVerification: "required",
					},
				}),
			};
		return {
			id: issued.id,
			options: await generateAuthenticationOptions({
				rpID: this.config.rpId,
				challenge: issued.challenge,
				allowCredentials: state.keys.map((key) => ({
					id: key.id,
					transports: key.transports as never,
				})),
				userVerification: "required",
			}),
		};
	}
	private take(
		state: Store,
		id: string,
		action: ApprovalAction,
		item: string,
		binding: Binding,
	) {
		const challenge = state.challenges[id];
		delete state.challenges[id];
		this.save(state);
		if (
			!challenge ||
			challenge.expiresAt <= this.now() ||
			challenge.action !== action ||
			challenge.item !== item ||
			challenge.binding !== binding
		)
			throw Object.assign(
				Error("invalid, expired, or mismatched passkey challenge"),
				{ code: "forbidden" },
			);
		return challenge;
	}
	async verifyAssertion(
		id: string,
		action: Exclude<ApprovalAction, "enroll">,
		item: string,
		binding: Binding,
		response: AuthenticationResponseJSON,
	) {
		const state = this.load();
		const challenge = this.take(state, id, action, item, binding);
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
		if (
			!verified.verified ||
			verified.authenticationInfo.newCounter <= key.counter
		)
			throw Object.assign(Error("passkey assertion refused"), {
				code: "forbidden",
			});
		key.counter = verified.authenticationInfo.newCounter;
		this.save(state);
	}
	async verifyEnrollment(id: string, response: RegistrationResponseJSON) {
		const state = this.load();
		const challenge = this.take(state, id, "enroll", this.agent, "enroll");
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
		this.save(state);
		return credential.id;
	}
}

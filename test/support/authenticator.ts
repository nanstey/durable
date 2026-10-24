import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";

/** A real ES256 authenticator: no verifier substitutions, none attestation. */
export function authenticator(
	rpId = "console.test",
	origin = "https://console.test",
) {
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	const jwk = publicKey.export({ format: "jwk" });
	const id = randomBytes(32);
	const cose = isoCBOR.encode(
		new Map<number, number | Uint8Array>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(jwk.x!, "base64url")],
			[-3, Buffer.from(jwk.y!, "base64url")],
		]),
	);
	function data(counter: number, registration = false, rp = rpId) {
		const count = Buffer.alloc(4);
		count.writeUInt32BE(counter);
		const size = Buffer.alloc(2);
		size.writeUInt16BE(id.length);
		return Buffer.concat([
			createHash("sha256").update(rp).digest(),
			Buffer.from([registration ? 0x45 : 0x05]),
			count,
			...(registration ? [Buffer.alloc(16), size, id, cose] : []),
		]);
	}
	function client(challenge: string, type: string, clientOrigin = origin) {
		return Buffer.from(
			JSON.stringify({
				type,
				challenge,
				origin: clientOrigin,
				crossOrigin: false,
			}),
		);
	}
	return {
		id: id.toString("base64url"),
		registration(challenge: string): RegistrationResponseJSON {
			return {
				id: id.toString("base64url"),
				rawId: id.toString("base64url"),
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: client(challenge, "webauthn.create").toString(
						"base64url",
					),
					attestationObject: Buffer.from(
						isoCBOR.encode(
							new Map<string, string | Uint8Array | Map<string, string>>([
								["fmt", "none"],
								["attStmt", new Map()],
								["authData", data(0, true)],
							]),
						),
					).toString("base64url"),
					transports: ["internal"],
				},
			};
		},
		assertion(
			challenge: string,
			counter = 0,
			overrides: { origin?: string; rpId?: string } = {},
		): AuthenticationResponseJSON {
			const authData = data(counter, false, overrides.rpId);
			const clientData = client(challenge, "webauthn.get", overrides.origin);
			const signature = sign(
				"sha256",
				Buffer.concat([
					authData,
					createHash("sha256").update(clientData).digest(),
				]),
				privateKey,
			);
			return {
				id: id.toString("base64url"),
				rawId: id.toString("base64url"),
				type: "public-key",
				clientExtensionResults: {},
				response: {
					authenticatorData: authData.toString("base64url"),
					clientDataJSON: clientData.toString("base64url"),
					signature: signature.toString("base64url"),
				},
			};
		},
	};
}

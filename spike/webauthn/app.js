// Plain navigator.credentials with base64url helpers (no @simplewebauthn/browser needed).
const b64u = {
	enc: (buf) =>
		btoa(String.fromCharCode(...new Uint8Array(buf)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, ""),
	dec: (s) =>
		Uint8Array.from(
			atob(
				s.replace(/-/g, "+").replace(/_/g, "/") +
					"===".slice((s.length + 3) % 4),
			),
			(c) => c.charCodeAt(0),
		),
};
const post = (u, v) =>
	fetch(u, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(v),
	}).then((r) => r.json());
window.spikeRegister = async () => {
	const o = await fetch("/reg/options").then((r) => r.json());
	const c = await navigator.credentials.create({
		publicKey: {
			...o,
			challenge: b64u.dec(o.challenge),
			user: { ...o.user, id: b64u.dec(o.user.id) },
			excludeCredentials: (o.excludeCredentials ?? []).map((x) => ({
				...x,
				id: b64u.dec(x.id),
			})),
		},
	});
	return post("/reg/verify", {
		id: c.id,
		rawId: b64u.enc(c.rawId),
		type: c.type,
		clientExtensionResults: c.getClientExtensionResults(),
		response: {
			clientDataJSON: b64u.enc(c.response.clientDataJSON),
			attestationObject: b64u.enc(c.response.attestationObject),
			transports: c.response.getTransports?.(),
		},
	});
};
window.spikeAssert = async (tamper) => {
	const o = await fetch("/auth/options").then((r) => r.json());
	const a = await navigator.credentials.get({
		publicKey: { ...o, challenge: b64u.dec(o.challenge) },
	}); // discoverable: no allowCredentials
	return post("/auth/verify" + (tamper ? "?tamper=1" : ""), {
		id: a.id,
		rawId: b64u.enc(a.rawId),
		type: a.type,
		clientExtensionResults: a.getClientExtensionResults(),
		response: {
			clientDataJSON: b64u.enc(a.response.clientDataJSON),
			authenticatorData: b64u.enc(a.response.authenticatorData),
			signature: b64u.enc(a.response.signature),
			userHandle: a.response.userHandle
				? b64u.enc(a.response.userHandle)
				: undefined,
		},
	});
};
window.spikeSW = async () => {
	const r = await navigator.serviceWorker.register("sw.js");
	await navigator.serviceWorker.ready;
	return { scope: new URL(r.scope).pathname, active: !!r.active };
};

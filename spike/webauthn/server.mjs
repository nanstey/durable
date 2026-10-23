// Spike (throwaway): minimal WebAuthn RP on http://localhost:<port> (RP ID "localhost") + PWA files.
// Verifies with @simplewebauthn/server. In-memory state only. Never bind beyond 127.0.0.1.
//   node server.mjs <port> <dir-with-index.html-and-pwa-files>

import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";

const [port, dir] = [Number(process.argv[2]), process.argv[3]];
const rpID = "localhost",
	origin = `http://localhost:${port}`;
let regChallenge, authChallenge, cred; // single test user
const log = [];
const body = (req) =>
	new Promise((r) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => r(b ? JSON.parse(b) : {}));
	});
const json = (res, v, code = 200) => {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(v));
};
const types = {
	".html": "text/html",
	".js": "text/javascript",
	".json": "application/manifest+json",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
};

http
	.createServer(async (req, res) => {
		try {
			const u = new URL(req.url, origin);
			if (u.pathname === "/reg/options") {
				const o = await generateRegistrationOptions({
					rpName: "durable spike",
					rpID,
					userName: "spike-user",
					attestationType: "none",
					authenticatorSelection: {
						residentKey: "required",
						userVerification: "required",
					},
				});
				regChallenge = o.challenge;
				return json(res, o);
			}
			if (u.pathname === "/reg/verify") {
				const r = await verifyRegistrationResponse({
					response: await body(req),
					expectedChallenge: regChallenge,
					expectedOrigin: origin,
					expectedRPID: rpID,
					requireUserVerification: true,
				});
				if (r.verified) cred = r.registrationInfo.credential;
				const out = {
					verified: r.verified,
					counter: cred?.counter,
					fmt: r.registrationInfo?.fmt,
					credentialDeviceType: r.registrationInfo?.credentialDeviceType,
					backedUp: r.registrationInfo?.credentialBackedUp,
					uv: r.registrationInfo?.userVerified,
				};
				log.push({ step: "register", ...out });
				return json(res, out);
			}
			if (u.pathname === "/auth/options") {
				const o = await generateAuthenticationOptions({
					rpID,
					userVerification: "required",
				});
				authChallenge = o.challenge;
				return json(res, o);
			}
			if (u.pathname === "/auth/verify") {
				const tamper = u.searchParams.get("tamper") === "1";
				const expectedChallenge = tamper
					? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
					: authChallenge;
				let out;
				try {
					const r = await verifyAuthenticationResponse({
						response: await body(req),
						expectedChallenge,
						expectedOrigin: origin,
						expectedRPID: rpID,
						credential: cred,
						requireUserVerification: true,
					});
					out = {
						verified: r.verified,
						storedCounterBefore: cred.counter,
						newCounter: r.authenticationInfo.newCounter,
						uv: r.authenticationInfo.userVerified,
					};
					if (r.verified) cred.counter = r.authenticationInfo.newCounter;
				} catch (e) {
					out = { verified: false, error: String(e.message).slice(0, 200) };
				}
				log.push({
					step: tamper ? "assert-wrong-challenge" : "assert",
					...out,
				});
				return json(res, out);
			}
			if (u.pathname === "/log") return json(res, log);
			const f =
				u.pathname === "/"
					? "index.html"
					: u.pathname.slice(1).replace(/\.\./g, "");
			const ext = f.slice(f.lastIndexOf("."));
			let data;
			try {
				data = readFileSync(join(dir, f));
			} catch {
				res.writeHead(404);
				return res.end();
			}
			res.writeHead(200, {
				"content-type": types[ext] ?? "application/octet-stream",
			});
			res.end(data);
		} catch (e) {
			if (!res.headersSent) json(res, { error: String(e.message ?? e) }, 500);
		}
	})
	.listen(port, "127.0.0.1", () => console.log(`listening ${origin}`));

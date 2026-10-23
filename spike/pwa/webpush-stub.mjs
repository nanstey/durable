// Spike (throwaway): web-push VAPID send to a LOCAL stub endpoint (no real push service is contacted).
// The stub uses a throwaway self-signed cert (web-push always uses HTTPS): node webpush-stub.mjs <key.pem> <cert.pem>
// Synthetic subscription keys come from node:crypto (P-256 ECDH + 16 random auth bytes).
import https from "node:https";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import webpush from "web-push";

const seen = [];
const [keyFile, certFile] = process.argv.slice(2);
const agent = new https.Agent({ rejectUnauthorized: false }); // local stub only
const stub = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const h = req.headers;
    seen.push({ method: req.method, path: req.url, authorization: h.authorization?.replace(/t=[^,]+/, "t=<jwt>").replace(/k=[^,\s]+/, "k=<vapid-public-key>"),
      contentEncoding: h["content-encoding"], contentType: h["content-type"], ttl: h.ttl, urgency: h.urgency, topic: h.topic, bodyBytes: Buffer.concat(chunks).length });
    res.writeHead(201); res.end();
  });
}).listen(0, "127.0.0.1");
await new Promise((r) => stub.once("listening", r));
const endpoint = `https://127.0.0.1:${stub.address().port}/push/abc`;

const vapid = webpush.generateVAPIDKeys();
webpush.setVapidDetails("mailto:operator@example.invalid", vapid.publicKey, vapid.privateKey);
const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
const sub = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };

const out = { vapidPublicKeyLen: Buffer.from(vapid.publicKey, "base64url").length };
const payload = JSON.stringify({ title: "approval needed", body: "agent a1 PR #12" });
let t0 = Date.now();
const r = await webpush.sendNotification(sub, payload, { TTL: 600, urgency: "high", topic: "approval", agent });
out.small = { status: r.statusCode, ms: Date.now() - t0, payloadBytes: Buffer.byteLength(payload) };
for (const n of [3993, 3994, 4096, 5000]) {
  try { const rr = await webpush.sendNotification(sub, "x".repeat(n), { agent }); out["bytes" + n] = { status: rr.statusCode }; }
  catch (e) { out["bytes" + n] = { error: String(e.message).slice(0, 120) }; }
}
out.stubReceived = seen;
console.log(JSON.stringify(out, null, 1));
stub.close();

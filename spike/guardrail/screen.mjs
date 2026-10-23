// Spike (throwaway): credential-screening heuristic for chat/steer input, with false-positive measurement.
// Positive samples are generated at runtime from random characters, so no token-shaped literal is stored here.
import { randomBytes } from "node:crypto";

const rnd = (n, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") =>
  Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const entropy = (s) => { const f = {}; for (const c of s) f[c] = (f[c] ?? 0) + 1; return -Object.values(f).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0); };

export const PATTERNS = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/],
  ["sk-style-key", /\bsk-(?:ant-[a-z]{3}\d{2}-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/],
  ["private-key-block", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["secret-assignment", /\b(?:api[_-]?key|secret|token|passw(?:or)?d|bearer)\b["']?\s*[:=]\s*["']?(?=[^\s"']{12,})(?=[^\s"']*\d)(?=[^\s"']*[A-Za-z])[^\s"']+/i],
];
// v1 (untuned) generic rule: any 32+ char run of key-ish characters with entropy >= 3.5.
const genericV1 = (t) => (t.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some((w) => entropy(w) >= 3.5);
// v2 (tuned): 32+ chars, entropy >= 4.0, mixed upper+lower+digit, and not a known benign shape.
const BENIGN = [/^[0-9a-f]{32,128}$/i, /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/, /^[0-9a-f]{8}-[0-9a-f]{4}-/i, /^[A-Za-z]+(?:[-_/][A-Za-z]+){3,}$/];
const genericV2 = (t) => (t.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some((w) =>
  entropy(w) >= 4.0 && /[A-Z]/.test(w) && /[a-z]/.test(w) && /\d/.test(w) && !BENIGN.some((b) => b.test(w)) && !/[/]/.test(w.replace(/^[^/]*\/\//, "")));

export function screen(text, { generic = genericV2 } = {}) {
  const hits = PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
  if (generic(text)) hits.push("high-entropy");
  return hits;
}

const NORMAL = [
  "please rebase onto main and rerun the tests",
  "why did the gate say wait-human on PR #42?",
  "pause the scout for an hour, I'm reviewing the queue",
  "commit 9f3c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f broke the build",
  "the head sha is 2580b1a, approve after CI is green",
  "run id 01a16786-f24b-7211-abe6-1b6ba0beb405 is stuck",
  "lockfile has integrity sha512-q2xs3FqV0nYk1pQe7cR8ZbH9tW4uL5mN6oP7aB8cD9eF0gH1iJ2kL3mN4oP5qR6sT7uV8wX9yZ0aB1cD2eF3gH4iJ==",
  "docker image digest sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "see https://github.com/acme/api/pull/17/files#diff-3a7b1c9e2f4d6a8b0c2e4f6a8b0c2d4e6f8a0b2c",
  "move src/console/approval/webauthnChallengeStore.ts next to src/console/approval/index.ts",
  "set GH_TOKEN with pi-secret, never paste it here",
  "the token budget for the reviewer is 200k per day",
  "password reset flow needs a test for expired links",
  "use the bearer token from the console registry file, not the env",
  "rename getAuthorizationHeaderForProviderRequest to authHeader",
  "base64 of hello world is aGVsbG8gd29ybGQ=",
  "explain item acme/api#118 and why it is ineligible",
  "set priority high on the flaky-test issue",
  "try `node --experimental-strip-types test/examples/14-chat.ts`",
  "CSP: default-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "the npm package is @earendil-works/pi-durable@1.4.0 pinned with pi-ai 1.4.0",
  "abort the current turn, it's looping on the same grep",
  "ok",
  "can you compare MTIzNDU2Nzg5MGFiY2RlZg and the other fixture id?",
  "the VAPID subject should be mailto:operator@example.invalid",
  "steer: focus on the failing test in test/gate/merge.test.ts only",
  "this function is O(n^2), refactor with a Map keyed by repo slug",
  "rotate tokens every 90 days; the expiry field is expiresAt",
  "the trace id is 4bf92f3577b34da6a3ce929d0e0e4736 from the logs",
  "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 is the alphabet I want for ids",
];
const POSITIVE = () => [
  "here is my token " + "gh" + "p_" + rnd(36),
  "use " + "github" + "_pat_" + rnd(22) + "_" + rnd(59),
  "key: " + "sk" + "-ant-" + "api03-" + rnd(80, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"),
  "OPENAI " + "sk" + "-proj-" + rnd(48),
  "-----BEGIN " + "OPENSSH PRIVATE KEY-----\n" + rnd(64),
  "aws " + "AK" + "IA" + rnd(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
  "google " + "AI" + "za" + rnd(35),
  "slack " + "xo" + "xb-" + rnd(12, "0123456789") + "-" + rnd(24),
  "jwt " + "ey" + "J" + rnd(20) + "." + "ey" + "J" + rnd(30) + "." + rnd(43),
  "api_key=" + rnd(10) + "9" + rnd(10),
  "password: " + "Tr0ub4dor" + rnd(6),
  "random secret " + rnd(40),
];

for (const [label, gen] of [["v1 (untuned generic)", (t) => screen(t, { generic: genericV1 })], ["v2 (tuned generic)", (t) => screen(t)]]) {
  const fp = NORMAL.map((t) => [t, gen(t)]).filter(([, h]) => h.length);
  const pos = POSITIVE(); const fn = pos.filter((t) => gen(t).length === 0);
  console.log(`${label}: false positives ${fp.length}/${NORMAL.length}, detected ${pos.length - fn.length}/${pos.length}`);
  for (const [t, h] of fp) console.log("  FP", h.join(","), "<-", t.slice(0, 70));
  for (const t of fn) console.log("  MISS <-", t.slice(0, 12) + "...");
}

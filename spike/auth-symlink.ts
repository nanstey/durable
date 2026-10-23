// Spike (throwaway): AuthStorage write path through symlinks, with FABRICATED credentials only.
// No provider is contacted. AuthStorage is not a public export of pi-coding-agent >= 0.80.8, so this
// deep-imports dist/core/auth-storage.js by file URL (test only; product code must use ModelRuntime or
// its own CredentialStore).
//   node auth-symlink.ts setup <root>
//   node auth-symlink.ts bump <authPath> <n>     # n serialized modify() increments of a counter
//   node auth-symlink.ts report <root>
import { mkdirSync, writeFileSync, symlinkSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js")).href);
const { AuthStorage } = mod;
const [cmd, a, b] = process.argv.slice(2);
const fake = (n: number) => ({ type: "api_key", key: `fake-not-a-secret-${n}` });

if (cmd === "setup") {
  const C = join(a, "canonical"), D = join(a, "derived");
  mkdirSync(join(C, "auth-profiles"), { recursive: true, mode: 0o700 });
  mkdirSync(D, { recursive: true, mode: 0o700 });
  writeFileSync(join(C, "auth-profiles", "work.json"), JSON.stringify({ fakeprov: fake(0) }), { mode: 0o600 });
  writeFileSync(join(C, "auth.json"), JSON.stringify({ fakeprov: fake(0) }), { mode: 0o600 });
  symlinkSync(join(C, "auth-profiles"), join(D, "auth-profiles"));   // directory symlink (named profile)
  symlinkSync(join(C, "auth.json"), join(D, "auth.json"));           // file symlink (default profile)
} else if (cmd === "bump") {
  const store = AuthStorage.create(a);
  for (let i = 0; i < Number(b); i++) {
    await store.modify("fakeprov", async (cur: any) => fake(Number(String(cur?.key ?? "x-0").split("-").at(-1)) + 1));
  }
} else if (cmd === "report") {
  for (const p of ["derived/auth-profiles", "derived/auth.json"]) console.log(p, "isSymlink:", lstatSync(join(a, p)).isSymbolicLink());
  for (const p of ["canonical/auth-profiles/work.json", "canonical/auth.json"]) {
    const st = lstatSync(join(a, p));
    console.log(p, "regularFile:", st.isFile(), "mode:", (st.mode & 0o777).toString(8), "counter:", JSON.parse(readFileSync(join(a, p), "utf8")).fakeprov.key.split("-").at(-1));
  }
  console.log("leftover entries:", readdirSync(join(a, "canonical")), readdirSync(join(a, "derived")), readdirSync(join(a, "canonical/auth-profiles")));
}

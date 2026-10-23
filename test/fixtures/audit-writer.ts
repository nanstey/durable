import { audit } from "../../src/steward/audit.ts";

const actor = process.argv[2];
for (let n = 0; n < 30; n++)
	audit("concurrent", { event: "append", target: `${actor}:${n}` });

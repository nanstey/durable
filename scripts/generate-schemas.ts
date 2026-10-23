import { writeFileSync } from "node:fs";
import {
	agentSchema,
	machineSchema,
	manifestSchema,
	organizationSchema,
} from "../src/config/jsonSchemas.ts";

for (const [name, schema] of Object.entries({
	agent: agentSchema,
	machine: machineSchema,
	"profile-meta": manifestSchema,
	organization: organizationSchema,
})) {
	writeFileSync(
		`schema/${name}.schema.json`,
		`${JSON.stringify(schema, null, 2)}\n`,
	);
}

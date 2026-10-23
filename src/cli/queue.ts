import { localToken } from "../api/tokens.ts";
import { assignedPort } from "../steward/main.ts";

export async function queueCommand(agent: string, dryRun = false) {
	const url = `http://127.0.0.1:${assignedPort(agent)}/v1/queue`;
	if (dryRun) return `GET ${url}`;
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${localToken(agent)}` },
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) throw Error(`queue request failed (${response.status})`);
	return JSON.stringify(await response.json(), null, 2);
}

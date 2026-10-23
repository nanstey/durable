import { execa } from "execa";
import type { NotifyPayload } from "../types.ts";

export type GithubDelivery = "sent" | "skipped-self";
/**
 * A mention creates a GitHub notification for the selected login without
 * depending on issue-number parsing or granting assignment permissions.
 */
export async function deliverGithub(
	payload: NotifyPayload,
	targetLogin: string,
	agentLogin: string | undefined,
	env?: NodeJS.ProcessEnv,
): Promise<GithubDelivery> {
	if (agentLogin === targetLogin) return "skipped-self";
	if (!payload.target) throw Error("github notification requires a target URL");
	await execa(
		"gh",
		[
			"issue",
			"comment",
			payload.target,
			"--body",
			`@${targetLogin} ${payload.title ?? payload.event}`,
		],
		{
			reject: true,
			timeout: 15000,
			env,
		},
	);
	return "sent";
}

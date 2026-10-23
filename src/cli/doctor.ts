import { loadAgent, loadMachine } from "../config/load.ts";
import { doctor, type Report } from "../identity/doctor.ts";

export function doctorCommand(id: string): Report {
	try {
		return doctor(id, loadAgent(id), loadMachine());
	} catch {
		return {
			ok: false,
			checks: [
				{
					name: "configuration",
					ok: false,
					detail: "definition or machine file missing, invalid, or unreadable",
					fix: "create the agent definition and machine.yaml using schema/; assign the agent in machine agents",
				},
			],
		};
	}
}
export function formatDoctor(report: Report): string {
	return report.checks
		.map(
			(check) =>
				`${check.warning ? "WARN" : check.ok ? "PASS" : "FAIL"}\t${check.name}\t${check.detail}${!check.ok && check.fix ? `\n  Fix: ${check.fix}` : ""}`,
		)
		.join("\n");
}

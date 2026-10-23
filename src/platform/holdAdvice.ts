/** Platform-specific takeover instructions stay outside the daemon core. */
export function unconfirmedHoldReason(
	confirmedContainment: boolean,
	slices: string[],
): string {
	if (!confirmedContainment)
		return "Containment unconfirmed. Force-stop Termux in Android Settings or reboot the device (cgroup v1 Linux: reboot) before editing. Stopping the steward and /proc inspection cannot establish ownership; writers with cwd / may be invisible.";
	const commands =
		slices.map((slice) => `systemctl --user stop ${slice}`).join("; ") ||
		"systemctl --user stop <slice>";
	return `Run ${commands} and confirm cgroup.events populated 0 before editing; run durable hold --verify.`;
}

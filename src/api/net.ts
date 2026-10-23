import { execa } from "execa";

export type PeerCheck = "required" | "optional" | "off";
type Whois = {
	Node?: { Tags?: string[]; UserProfile?: { LoginName?: string } };
	UserProfile?: { LoginName?: string };
};

export function loopbackBind(bind: string = "loopback") {
	if (bind !== "loopback" && bind !== "127.0.0.1" && bind !== "::1")
		throw Error("network.bind must be loopback or tailnet");
	return bind === "::1" ? "::1" : "127.0.0.1";
}

export async function tailnetAddress(
	explicit?: string,
	run = execa,
): Promise<string> {
	if (explicit) return checkedAddress(explicit);
	const result = await run("tailscale", ["ip", "-4"]);
	return checkedAddress(result.stdout.trim().split(/\s+/)[0] ?? "");
}

function checkedAddress(address: string) {
	const octets = address.split(".").map(Number);
	if (
		octets.length !== 4 ||
		octets.some(
			(octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
		) ||
		octets[0] !== 100 ||
		octets[1] < 64 ||
		octets[1] > 127
	)
		throw Error("tailscale did not return a valid tailnet IPv4 address");
	return address;
}

export async function peerAllowed(
	remoteAddress: string,
	allowedPeers: string[],
	run = execa,
): Promise<boolean> {
	if (!remoteAddress || !allowedPeers.length) return false;
	const result = await run("tailscale", ["whois", "--json", remoteAddress], {
		timeout: 5_000,
	});
	const whois = JSON.parse(result.stdout) as Whois;
	const names = [
		...(whois.Node?.Tags ?? []),
		whois.Node?.UserProfile?.LoginName,
		whois.UserProfile?.LoginName,
	].filter((value): value is string => Boolean(value));
	return names.some((name) => allowedPeers.includes(name));
}

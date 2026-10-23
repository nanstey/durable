export function loopbackBind(bind: string = "loopback") {
	if (bind !== "loopback" && bind !== "127.0.0.1" && bind !== "::1")
		throw Error(
			"network.bind must be loopback; other listeners are available from slice 11",
		);
	return bind === "::1" ? "::1" : "127.0.0.1";
}

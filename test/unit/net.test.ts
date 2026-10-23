import assert from "node:assert/strict";
import test from "node:test";
import { peerAllowed, tailnetAddress } from "../../src/api/net.ts";

const address = [100, 100, 1, 2].join(".");
test("tailnet address accepts an explicit address and rejects non-tailnet binds", async () => {
	const explicit = [100, 100, 10, 1].join(".");
	assert.equal(await tailnetAddress(explicit), explicit);
	await assert.rejects(() => tailnetAddress("0.0.0.0"));
});

test("whois allows only configured tags and fails closed for unknown peers", async () => {
	const run = async () => ({
		stdout: JSON.stringify({ Node: { Tags: ["tag:durable-console"] } }),
	});
	assert.equal(
		await peerAllowed(address, ["tag:durable-console"], run as never),
		true,
	);
	assert.equal(await peerAllowed(address, ["tag:other"], run as never), false);
	assert.equal(await peerAllowed(address, [], run as never), false);
	await assert.rejects(() =>
		peerAllowed(address, ["tag:durable-console"], (async () => {
			throw Error("down");
		}) as never),
	);
});

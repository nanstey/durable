// Spike (throwaway): drive headless Chromium with a CDP virtual authenticator (no real passkey).
//   node drive.mjs <port>   (needs playwright-core; uses the system chromium)
import { chromium } from "playwright-core";
const port = process.argv[2];
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const page = await (await browser.newContext()).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto(`http://localhost:${port}/`);
const out = {};
out.register = await page.evaluate(() => window.spikeRegister());
out.creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.map((c) => ({ resident: c.isResidentCredential, rpId: c.rpId, signCount: c.signCount }));
out.assert1 = await page.evaluate(() => window.spikeAssert(false));
out.assert2 = await page.evaluate(() => window.spikeAssert(false));
out.assertWrongChallenge = await page.evaluate(() => window.spikeAssert(true));
out.sw = await page.evaluate(() => window.spikeSW());
await page.reload(); await page.waitForTimeout(500);
out.manifest = await cdp.send("Page.getAppManifest").then((m) => ({ url: new URL(m.url).pathname, errors: m.errors, parsed: !!m.parsed ?? null, len: m.data?.length }));
out.installabilityErrors = (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors;
out.controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
out.isSecureContext = await page.evaluate(() => window.isSecureContext);
out.pushManager = await page.evaluate(() => "PushManager" in window);
console.log(JSON.stringify(out, null, 1));
await browser.close();

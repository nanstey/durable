// Spike (throwaway): echo server for Tailscale checks. Output is safe to paste:
// - bind and peer addresses are redacted to their class (loopback / tailnet-100.x / other),
// - request headers are printed by NAME only; values are shown only for an allowlist of harmless headers,
//   and Tailscale identity headers show only their length.
//   node tailscale-headers.mjs <bindAddr> <port>     e.g. the node's 100.x address, or 127.0.0.1
import http from "node:http";
const [addr, port] = process.argv.slice(2);
const SHOW_VALUE = new Set(["accept", "accept-encoding", "connection", "content-length", "content-type", "x-forwarded-proto", "via"]);
const addrClass = (a = "") => {
  const v4 = a.replace(/^::ffff:/, "");
  if (v4 === "127.0.0.1" || v4 === "::1") return "<loopback>";
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4) || /^fd7a:115c:a1e0:/i.test(v4)) return "<tailnet-ip>";
  return "<other-ip>";
};
http.createServer((req, res) => {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) =>
    [k, /^tailscale-/i.test(k) ? `<redacted len=${String(v).length}>` : SHOW_VALUE.has(k) ? v : "<redacted>"]));
  const body = JSON.stringify({ remoteAddress: addrClass(req.socket.remoteAddress), sameAsBind: req.socket.remoteAddress?.replace(/^::ffff:/, "") === addr, remoteFamily: req.socket.remoteFamily, headerNames: Object.keys(req.headers), headers });
  console.log(body);
  res.setHeader("content-type", "application/json");
  res.end(body + "\n");
}).listen(Number(port), addr, () => console.log(`listening ${addrClass(addr)}:${port}`));

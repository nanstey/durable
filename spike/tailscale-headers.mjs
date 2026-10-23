// Spike (throwaway): echo server for Tailscale checks. Prints the peer address and request header
// NAMES (values of identity headers are redacted to their length), so output is safe to paste.
//   node tailscale-headers.mjs <bindAddr> <port>     e.g. the node's 100.x address, or 127.0.0.1
import http from "node:http";
const [addr, port] = process.argv.slice(2);
http.createServer((req, res) => {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) =>
    [k, /^tailscale-/i.test(k) ? `<redacted len=${String(v).length}>` : k === "host" ? "<host>" : v]));
  const body = JSON.stringify({ remoteAddress: req.socket.remoteAddress, remoteFamily: req.socket.remoteFamily, headers });
  console.log(body);
  res.setHeader("content-type", "application/json");
  res.end(body + "\n");
}).listen(Number(port), addr, () => console.log(`listening ${addr}:${port}`));

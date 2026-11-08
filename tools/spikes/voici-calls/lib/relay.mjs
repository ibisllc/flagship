// Spike stand-in for the Fly relay: raw TCP, routed by the ClientHello's SNI, bytes passed through untouched
// (TLS ends behind it, on the "phone"). Usage: node relay.mjs <listenHost> <listenPort> <sni>=<host:port>...
import net from "node:net";
import { readHello, GROUP_NAMES } from "./hello.mjs";
const [host, port, ...routes] = process.argv.slice(2);
const table = Object.fromEntries(routes.map((r) => { const [s, t] = r.split("="); const [h, p] = t.split(":"); return [s, { h, p: +p }]; }));
net.createServer((c) => {
  c.setNoDelay(true);
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const h = readHello(buf);
    if (h === undefined) return;
    c.off("data", onData);
    const t = h && table[h.sni];
    console.log(JSON.stringify({ ev: "hello", sni: h?.sni ?? null, alpn: h?.alpn ?? [], groups: (h?.groups ?? []).map((g) => GROUP_NAMES[g] ?? "0x" + g.toString(16)), routed: !!t }));
    if (!t) return c.destroy();
    const u = net.connect(t.p, t.h, () => { u.setNoDelay(true); u.write(buf); c.pipe(u); u.pipe(c); });
    u.on("error", () => c.destroy()); c.on("error", () => u.destroy());
    c.on("close", () => u.destroy()); u.on("close", () => c.destroy());
  };
  c.on("data", onData);
}).listen(+port, host, () => console.log(JSON.stringify({ ev: "listening", host, port })));

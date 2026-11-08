// Option B "phone": TLS ends here (as it would on the phone), WebSocket at /api/phone/call.
// Every 20 ms it sends one fixed-size AES-256-GCM frame; it records the one-way delay of every frame it receives.
// Usage: node phone-b.mjs <certDir> <port> <resultsDir>
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";
import { accept } from "./ws.mjs";
const [certDir, port, resultsDir] = process.argv.slice(2);
const KEY = Buffer.alloc(32, 7); // spike only: the real key comes from the X-Wing exchange
const PAYLOAD = 64; // CBR 24 kbps Opus at 20 ms is 60 bytes; padded to a fixed 64
const nonce = (dir, seq) => { const n = Buffer.alloc(12); n.writeUInt32BE(dir, 0); n.writeBigUInt64BE(BigInt(seq), 4); return n; };
const aad = (dir, seq) => Buffer.from(`flagship/spike-call/v1|${dir}|${seq}`);
const srv = https.createServer({ cert: fs.readFileSync(`${certDir}/leaf.pem`), key: fs.readFileSync(`${certDir}/leaf.key`) }, (q, r) => { r.writeHead(404).end(); });
srv.on("secureConnection", (s) => console.log(JSON.stringify({ ev: "tls", protocol: s.getProtocol(), cipher: s.getCipher()?.name, group: s.getEphemeralKeyInfo?.()?.name })));
srv.on("upgrade", (req, socket) => {
  const run = new URL(req.url, "https://x").searchParams.get("run") ?? "run";
  const got = []; let sentN = 0, droppedAtSender = 0, bad = 0, seqOut = 0;
  const ws = accept(req, socket, (m) => {
    const seq = Number(m.readBigUInt64BE(0));
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", KEY, nonce(1, seq)); d.setAAD(aad(1, seq));
      d.setAuthTag(m.subarray(m.length - 16));
      const pt = Buffer.concat([d.update(m.subarray(8, m.length - 16)), d.final()]);
      got.push([seq, pt.readDoubleBE(0), performance.timeOrigin + performance.now()]);
    } catch { bad++; }
  });
  const timer = setInterval(() => {
    if (ws.queued > 3 * 100) { droppedAtSender++; seqOut++; return; }
    const seq = seqOut++; const pt = Buffer.alloc(8 + PAYLOAD); pt.writeDoubleBE(performance.timeOrigin + performance.now(), 0); crypto.randomFillSync(pt, 8);
    const c = crypto.createCipheriv("aes-256-gcm", KEY, nonce(2, seq)); c.setAAD(aad(2, seq));
    const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    const head = Buffer.alloc(8); head.writeBigUInt64BE(BigInt(seq));
    ws.send(Buffer.concat([head, ct])); sentN++;
  }, 20);
  socket.on("close", () => {
    clearInterval(timer);
    fs.writeFileSync(`${resultsDir}/${run}-phone-received.json`, JSON.stringify({ got, sentN, droppedAtSender, bad }));
    console.log(JSON.stringify({ ev: "closed", run, received: got.length, sentN, droppedAtSender, bad }));
  });
});
srv.listen(+port, "127.0.0.1", () => console.log(JSON.stringify({ ev: "listening", port })));

// Minimal RFC 6455 server side for binary frames (no deps; the spike only).
import crypto from "node:crypto";
export function accept(req, socket, onMessage) {
  const key = req.headers["sec-websocket-key"];
  const acceptKey = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, p = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); p = 10; }
      const masked = buf[1] & 0x80; const mask = masked ? buf.subarray(p, p + 4) : null; if (masked) p += 4;
      if (buf.length < p + len) return;
      const payload = Buffer.from(buf.subarray(p, p + len));
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(p + len);
      if (op === 8) { socket.end(); return; }
      if (op === 2) onMessage(payload);
    }
  });
  return {
    send(b) {
      const n = b.length;
      const head = n < 126 ? Buffer.from([0x82, n]) : Buffer.from([0x82, 126, n >> 8, n & 255]);
      socket.write(Buffer.concat([head, b]));
    },
    get queued() { return socket.writableLength; },
  };
}

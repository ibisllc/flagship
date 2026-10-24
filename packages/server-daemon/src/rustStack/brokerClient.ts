/**
 * The daemon's side of the broker's privd v1 socket, for the host operations the broker owns
 * once the Rust path is on (power). Same framing as packages/privd: a 4-byte big-endian
 * length, then JSON; `hello` first. Each call opens one short connection.
 */
import { Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { BROKER_V1_SOCKET, RUST_RUN_DIR } from "./units.js";

function frame(v: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(v), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export async function brokerCall(op: string, args: Record<string, unknown>, socketPath = BROKER_V1_SOCKET, timeoutMs = 30_000): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const s = new Socket();
    let buf = Buffer.alloc(0);
    const replies: Array<{ id: number; ok: boolean; result?: unknown; message?: string; code?: string }> = [];
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("the broker did not answer in time"));
    }, timeoutMs);
    t.unref?.();
    const done = (e: Error | null, v?: unknown) => {
      clearTimeout(t);
      s.destroy();
      if (e) reject(e);
      else resolve(v);
    };
    s.on("error", (e) => done(e));
    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0 || n > 1 << 20) return done(new Error("bad frame from the broker"));
        if (buf.length < 4 + n) break;
        replies.push(JSON.parse(buf.subarray(4, 4 + n).toString("utf8")));
        buf = buf.subarray(4 + n);
      }
      const hello = replies.find((r) => r.id === 1);
      if (hello && !hello.ok) return done(new Error(`the broker refused hello: ${hello.message ?? hello.code}`));
      const r = replies.find((x) => x.id === 2);
      if (r) return r.ok ? done(null, r.result) : done(new Error(`the broker refused ${op}: ${r.message ?? r.code}`));
    });
    s.connect(socketPath, () => {
      s.write(frame({ id: 1, op: "hello", args: { version: 1 } }));
      s.write(frame({ id: 2, op, args }));
    });
  });
}

/** The broker is on this box's real path: its Rust binary was chosen and its socket is up. */
export function brokerActive(runDir = RUST_RUN_DIR, socketPath = BROKER_V1_SOCKET): boolean {
  try {
    return readFileSync(`${runDir}/broker.choice`, "utf8").trim() === "rust" && existsSync(socketPath);
  } catch {
    return false;
  }
}

/**
 * An app's files folder through the broker's `appdata.files` (plan G6): the daemon names the app,
 * never a volume path or an argv, and a broker refusal reaches the caller with its reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokerFiles } from "../src/appCopy/ops.js";
import { archiveIsolationStats } from "../src/serverArchive/isolation.js";

let server: Server | null = null;
let dir = "";
afterEach(() => {
  server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A v1 broker that records each request and answers with `answer`. */
async function fakeBroker(answer: (args: Record<string, unknown>) => Record<string, unknown>): Promise<{ sock: string; seen: Array<{ op: string; args: Record<string, unknown> }> }> {
  dir = mkdtempSync(join(tmpdir(), "brk-"));
  const sock = join(dir, "privd.sock");
  const seen: Array<{ op: string; args: Record<string, unknown> }> = [];
  server = createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const req = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")) as { id: number; op: string; args: Record<string, unknown> };
        buf = buf.subarray(4 + n);
        const body = req.op === "hello" ? { id: req.id, ok: true, result: { v: 1 } } : (seen.push({ op: req.op, args: req.args }), { id: req.id, ...answer(req.args) });
        const out = Buffer.from(JSON.stringify(body));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(out.length);
        c.write(Buffer.concat([head, out]));
      }
    });
  });
  await new Promise<void>((r) => server!.listen(sock, r));
  return { sock, seen };
}

describe("appdata.files through the broker", () => {
  it("names the app, not the volume, and counts the effect", async () => {
    const b = await fakeBroker(() => ({ ok: true, result: { stdout: "4096\t/data\n", stderr: "" } }));
    const before = archiveIsolationStats.brokerFiles;
    await brokerFiles("dump", "flagship-files-alice--chess", "/var/flagship/archives/x/files.tar", b.sock);
    expect(await brokerFiles("size", "flagship-files-alice--chess", undefined, b.sock)).toBe("4096\t/data\n");
    expect(b.seen).toEqual([
      { op: "appdata.files", args: { action: "dump", installation: "alice--chess", path: "/var/flagship/archives/x/files.tar" } },
      { op: "appdata.files", args: { action: "size", installation: "alice--chess" } },
    ]);
    expect(archiveIsolationStats.brokerFiles - before).toBe(2);
  });

  it("names a store generation as a number, never inside the app's name", async () => {
    const b = await fakeBroker(() => ({ ok: true, result: { stdout: "", stderr: "" } }));
    await brokerFiles("restore", "flagship-files-alice--chess--g3", "/var/flagship/r/files.tar", b.sock);
    expect(b.seen).toEqual([{ op: "appdata.files", args: { action: "restore", installation: "alice--chess", generation: 3, path: "/var/flagship/r/files.tar" } }]);
    await expect(brokerFiles("size", "flagship-files-alice--chess--g0", undefined, b.sock)).rejects.toThrow(/not an app's files volume/);
  });

  it("refuses a dev or foreign volume before asking, and passes the broker's refusal on", async () => {
    const b = await fakeBroker(() => ({ ok: false, code: "failed", message: "exited with code null: the files archive was refused: a link in the archive points outside its folder (symlink-escape)" }));
    await expect(brokerFiles("restore", "flagship-devfiles-alice--chess", "/var/flagship/x", b.sock)).rejects.toThrow(/not an app's files volume/);
    expect(b.seen).toHaveLength(0);
    const refused = archiveIsolationStats.brokerRefusals;
    await expect(brokerFiles("restore", "flagship-files-alice--chess", "/var/flagship/x.tar", b.sock)).rejects.toThrow(/symlink-escape/);
    expect(archiveIsolationStats.brokerRefusals - refused).toBe(1);
  });
});

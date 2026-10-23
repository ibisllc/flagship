import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { KeydServer, KeydService, type KeydServiceInit } from "../src/index.js";

export const SEED = new Uint8Array(32).fill(0x42);
export const SWK = new Uint8Array(32).fill(0x11);
export const CGK = new Uint8Array(32).fill(0x22);

export function tmp(): { dir: string; sock: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "keyd-"));
  return { dir, sock: join(dir, "k.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function startInProcess(init: Partial<KeydServiceInit> = {}, extra: Partial<ConstructorParameters<typeof KeydServer>[0]> = {}) {
  const t = tmp();
  const service = new KeydService({ identitySeed: SEED, swk: SWK, cgk: CGK, ...init });
  const server = new KeydServer({ socketPath: t.sock, service, auditPath: join(t.dir, "audit.log"), ...extra });
  await server.start();
  return { ...t, service, server, audit: join(t.dir, "audit.log"), stop: async () => (await server.stop(), t.cleanup()) };
}

/** keyd in a worker thread, so a synchronous client on this thread can block while it answers. */
export async function startInWorker(): Promise<{ sock: string; stop: () => Promise<void> }> {
  const t = tmp();
  const dist = new URL("../dist/index.js", import.meta.url).href;
  const code = `
    const { workerData, parentPort } = require("node:worker_threads");
    (async () => {
      const k = await import(workerData.dist);
      const service = new k.KeydService({ identitySeed: Uint8Array.from(workerData.seed), swk: Uint8Array.from(workerData.swk), cgk: Uint8Array.from(workerData.cgk) });
      const server = new k.KeydServer({ socketPath: workerData.sock, service });
      await server.start();
      parentPort.postMessage("ready");
      parentPort.on("message", async (m) => { if (m === "stop") { await server.stop(); process.exit(0); } });
    })();`;
  const worker = new Worker(code, { eval: true, workerData: { dist, sock: t.sock, seed: [...SEED], swk: [...SWK], cgk: [...CGK] } });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  return {
    sock: t.sock,
    stop: async () => {
      worker.postMessage("stop");
      await new Promise((r) => worker.once("exit", r));
      t.cleanup();
    },
  };
}

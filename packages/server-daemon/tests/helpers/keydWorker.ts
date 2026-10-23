import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** keyd in a worker thread so a synchronous client on this thread can block while it answers. */
export async function startKeydWorker(keys: { seed: Uint8Array; swk?: Uint8Array; cgk?: Uint8Array }): Promise<{ sock: string; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "keyd-d-"));
  const sock = join(dir, "k.sock");
  const dist = new URL("../../../keyd/dist/index.js", import.meta.url).href;
  const code = `
    const { workerData, parentPort } = require("node:worker_threads");
    (async () => {
      const k = await import(workerData.dist);
      const service = new k.KeydService({
        identitySeed: Uint8Array.from(workerData.seed),
        swk: workerData.swk ? Uint8Array.from(workerData.swk) : undefined,
        cgk: workerData.cgk ? Uint8Array.from(workerData.cgk) : undefined,
      });
      const server = new k.KeydServer({ socketPath: workerData.sock, service, rateLimits: { "*": { perSecond: 100000, burst: 100000 } } });
      await server.start();
      parentPort.postMessage("ready");
      parentPort.on("message", async (m) => { if (m === "stop") { await server.stop(); process.exit(0); } });
    })();`;
  const worker = new Worker(code, {
    eval: true,
    workerData: { dist, sock, seed: [...keys.seed], swk: keys.swk ? [...keys.swk] : null, cgk: keys.cgk ? [...keys.cgk] : null },
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  return {
    sock,
    stop: async () => {
      worker.postMessage("stop");
      await new Promise((r) => worker.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

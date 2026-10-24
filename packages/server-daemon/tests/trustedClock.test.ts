import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signSignedTime, MAINTAINER_PINNED_MANDATE_HASH } from "@flagship/protocol";
import { TrustedClock } from "../src/trustedClock.js";

const CA = new Uint8Array(32).fill(0xca);
const CA_PUB = Buffer.from(ed.getPublicKey(CA)).toString("hex");
const REAL = 1_790_000_000_000;
void MAINTAINER_PINNED_MANDATE_HASH;

function harness(opts: { sys: number; answer?: (nonce: string) => unknown; status?: number; keys?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "tclock-"));
  let mono = 0;
  let sys = opts.sys;
  const clock = new TrustedClock({
    comBaseUrl: "https://flagshipserver.test",
    chain: () => ({ authorizedCaKeys: () => opts.keys ?? [CA_PUB] }),
    floorPath: join(dir, "time-floor.json"),
    bootFloorPath: join(dir, "flagship-time-floor"),
    systemNow: () => sys,
    monotonic: () => mono,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      const nonce = JSON.parse(String(init.body)).nonce as string;
      return new Response(JSON.stringify(opts.answer ? opts.answer(nonce) : signSignedTime(nonce, REAL, CA)), { status: opts.status ?? 200 });
    }) as typeof fetch,
  });
  return { clock, dir, tick: (ms: number) => { mono += ms; sys += ms; }, setSys: (v: number) => { sys = v; } };
}

describe("the box's authenticated clock", () => {
  it("runs the signed time forward and never reads earlier than it, whatever the system clock says", async () => {
    const h = harness({ sys: REAL - 365 * 86_400_000 });
    expect(await h.clock.refresh()).toBe(true);
    expect(h.clock.status().source).toBe("signed");
    h.tick(1_000);
    expect(h.clock.now()).toBe(REAL + 1_000);
    h.setSys(0);
    expect(h.clock.now()).toBe(REAL + 1_000);
    expect(JSON.parse(readFileSync(join(h.dir, "time-floor.json"), "utf8")).floorMs).toBe(REAL);
    expect(readFileSync(join(h.dir, "flagship-time-floor"), "utf8")).toBe(`${REAL}\n`);
  });

  it("keeps the floor across a restart when .com cannot be reached, and says so", async () => {
    const h = harness({ sys: REAL - 10_000, status: 503 });
    writeFileSync(join(h.dir, "time-floor.json"), JSON.stringify({ floorMs: REAL }));
    await h.clock.load();
    expect(await h.clock.refresh()).toBe(false);
    expect(h.clock.status()).toMatchObject({ source: "floor", floorMs: REAL });
    expect(h.clock.now()).toBe(REAL);
  });

  it("refuses an answer under a key the pin does not authorize, or one behind the floor", async () => {
    const forged = harness({ sys: REAL, keys: ["00".repeat(32)] });
    expect(await forged.clock.refresh()).toBe(false);
    expect(forged.clock.status()).toMatchObject({ source: "system", lastRefusal: "key-not-authorized" });
    const behind = harness({ sys: REAL, answer: (n) => signSignedTime(n, REAL - 1, CA) });
    writeFileSync(join(behind.dir, "time-floor.json"), JSON.stringify({ floorMs: REAL }));
    await behind.clock.load();
    expect(await behind.clock.refresh()).toBe(false);
    expect(behind.clock.status().lastRefusal).toBe("behind-floor");
    const replay = harness({ sys: REAL, answer: () => signSignedTime("ee".repeat(32), REAL, CA) });
    expect(await replay.clock.refresh()).toBe(false);
    expect(replay.clock.status().lastRefusal).toBe("nonce");
  });
});

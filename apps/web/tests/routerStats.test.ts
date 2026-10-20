import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { routerStats } from "../src/tunnel/routerStats.js";
import { startSniRouter } from "../src/tunnel/sniRouter.js";
import { TunnelRegistry } from "../src/tunnel/registry.js";

// A minimal TLS ClientHello carrying an SNI, enough for parseClientHelloSni.
function clientHello(sni: string): Buffer {
  const name = Buffer.from(sni);
  const sniExt = Buffer.concat([Buffer.from([0x00, 0x00]), u16(name.length + 5), u16(name.length + 3), Buffer.from([0x00]), u16(name.length), name]);
  const exts = Buffer.concat([u16(sniExt.length), sniExt]);
  const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([0x01, 0x00]), exts]);
  const hs = Buffer.concat([Buffer.from([0x01]), Buffer.from([0x00, body.length >> 8, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}
function u16(n: number): Buffer {
  return Buffer.from([n >> 8, n & 0xff]);
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  routerStats.reset();
});

describe("router stats", () => {
  it("counts a name nobody serves, and keeps the name for the owner to see", async () => {
    routerStats.reset();
    const registry = new TunnelRegistry({ apex: "flagship.services" });
    const router = await startSniRouter(registry, { port: 0, host: "127.0.0.1" });
    closers.push(() => router.close());
    const s = connect(router.port, "127.0.0.1");
    closers.push(() => void s.destroy());
    s.on("error", () => {});
    await new Promise<void>((r) => s.once("connect", () => r()));
    s.write(clientHello("home.nobody.flagship.services"));
    await new Promise((r) => setTimeout(r, 200));
    const snap = routerStats.snapshot() as { noUser: number; noBoxRegistered: number; routed: number };
    expect(snap.routed).toBe(0);
    expect(snap.noUser + snap.noBoxRegistered).toBe(1);
  });

  it("keeps only the last few misses and can be reset", () => {
    routerStats.reset();
    for (let i = 0; i < 30; i++) routerStats.missed("hold-timeout", `h${i}.flagship.services`);
    const snap = routerStats.snapshot() as { recentMisses: Array<{ domain: string }> };
    expect(snap.recentMisses).toHaveLength(20);
    expect(snap.recentMisses[0]!.domain).toBe("h10.flagship.services");
    routerStats.reset();
    expect((routerStats.snapshot() as { recentMisses: unknown[] }).recentMisses).toEqual([]);
  });
});

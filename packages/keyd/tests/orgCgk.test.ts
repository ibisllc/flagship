import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeydService } from "../src/index.js";
import { OrgCgkError, verifyOrgCgkAdoption, type OrgCgkPin } from "../src/orgCgk.js";
import { CGK, SEED, SWK } from "./helpers.js";

const V = JSON.parse(readFileSync(join(__dirname, "../../protocol/test-vectors", "keyd-org-cgk", "vectors.json"), "utf8"));
const A = JSON.parse(readFileSync(join(__dirname, "../../protocol/test-vectors", "org-authority", "vectors.json"), "utf8"));

/** `$key` / `$approval` refs as org-authority/vectors.json writes them. */
const resolve = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(resolve);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return A.keys[o.$key].binding;
  if (typeof o.$approval === "number") return A.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
};
const chain = (name: string): unknown[] => {
  const c = V.chains[name];
  const entries = resolve(A.chains.find((x: { name: string }) => x.name === c.from).entries) as unknown[];
  return c.take ? entries.slice(0, c.take) : entries;
};

describe("keyd adopting a rotated org CGK (shared vectors)", () => {
  for (const c of V.cases as Array<{ name: string; chain: string; pin?: Partial<OrgCgkPin>; args: Record<string, unknown>; expect: { ok: boolean; code?: string; version?: number; keyHex?: string } }>) {
    it(c.name, () => {
      const pin = { ...V.pin, ...(c.pin ?? {}) } as OrgCgkPin;
      const run = () => verifyOrgCgkAdoption({ ...c.args, chain: chain(c.chain) }, pin, V.now);
      if (c.expect.ok) {
        const r = run();
        expect(r.version).toBe(c.expect.version);
        expect(Buffer.from(r.key).toString("hex")).toBe(c.expect.keyHex);
      } else {
        try {
          run();
          expect.fail("adopted");
        } catch (e) {
          expect(e).toBeInstanceOf(OrgCgkError);
          expect((e as OrgCgkError).code).toBe(c.expect.code);
        }
      }
    });
  }
});

describe("the cgk.orgAdopt and org.pin operations", () => {
  const ok = V.cases[0];
  const TOKEN = new Uint8Array(32).fill(0x3c);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

  it("pins the org only with the ceremony token, adopts one version up, keeps it, and refuses a replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "keyd-org-"));
    try {
      const saved: string[] = [];
      const svc = new KeydService({
        identitySeed: SEED, swk: SWK, cgk: CGK, store: { save: (n) => void saved.push(n) },
        ceremony: { token: TOKEN, notAfter: V.now + 60_000 }, orgPinPath: join(dir, "org.json"), now: () => V.now,
      });
      const adopt = { ...ok.args, chain: chain(ok.chain) };
      expect(() => svc.handle({ id: 1, op: "cgk.orgAdopt", args: adopt })).toThrow(/no org is pinned/);
      expect(() => svc.handle({ id: 2, op: "org.pin", args: { ...V.pin, ceremony: hex(new Uint8Array(32)) } })).toThrow(/boot ceremony/);
      expect(svc.handle({ id: 3, op: "org.pin", args: { ...V.pin, ceremony: hex(TOKEN) } }).result).toEqual({ stored: true });
      expect(() => svc.handle({ id: 4, op: "org.pin", args: { ...V.pin, orgId: "ab".repeat(16), ceremony: hex(TOKEN) } })).toThrow(/already pinned/);
      const before = svc.handle({ id: 5, op: "cgk.seal", args: { pt: "00" } });
      expect(svc.handle({ id: 6, op: "cgk.orgAdopt", args: adopt }).result).toEqual({ version: 2 });
      expect(saved).toEqual(["cgk"]);
      const kept = JSON.parse(readFileSync(join(dir, "org.json"), "utf8"));
      expect(kept.cgkVersion).toBe(2);
      // keyd keeps the head it verified and the ring it holds (05c F4): a chain cut below that head is refused.
      expect(kept.oarVersion).toBe(1);
      expect(kept.oarHash).toMatch(/^[0-9a-f]{64}$/);
      expect(kept.cgkRingSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(() => svc.handle({ id: 10, op: "cgk.orgAdopt", args: { ...adopt, chain: chain(ok.chain).slice(0, 1) } })).toThrow(/stale-chain/);
      // The new CGK no longer opens what the old one sealed.
      expect(() => svc.handle({ id: 7, op: "cgk.open", args: { blob: before.result.blob } })).toThrow();
      expect(() => svc.handle({ id: 8, op: "cgk.orgAdopt", args: adopt })).toThrow(/stale/);
      // A fresh start reads the pin back.
      const again = new KeydService({ identitySeed: SEED, swk: SWK, cgk: CGK, orgPinPath: join(dir, "org.json"), now: () => V.now });
      expect(() => again.handle({ id: 9, op: "cgk.orgAdopt", args: adopt })).toThrow(/stale/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unknown arguments", () => {
    const svc = new KeydService({ identitySeed: SEED, now: () => V.now });
    expect(() => svc.handle({ id: 1, op: "cgk.orgAdopt", args: { ...ok.args, chain: [], extra: 1 } })).toThrow(/unknown field extra/);
  });
});

describe("review-cloud: keyd and superseded authority records", () => {
  it("review-cloud: refuses a CGK ring approved under a record older than the newest one it was shown", () => {
    const F = JSON.parse(readFileSync(join(__dirname, "../../../rust/crates/flagship-keyd/tests/fixtures/review-cloud-superseded-oar.json"), "utf8"));
    let code = "adopted";
    try {
      verifyOrgCgkAdoption({ ...F.args, chain: chain(F.chain) }, V.pin as OrgCgkPin, V.now);
    } catch (e) {
      code = (e as OrgCgkError).code;
    }
    expect(code).toBe("stale-oar");
  });
});

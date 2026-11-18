// The voucher link in the webapp (apps/web/public/webapp/lib/voucherLink.js) against
// packages/protocol/test-vectors/voucher-link/vectors.json: byte for byte with the TypeScript reference.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as L from "../public/webapp/lib/voucherLink.js";
import * as W from "../public/webapp/lib/vouchers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors/voucher-link/vectors.json"), "utf8"));
type Vo = { k: string; p: string; n: string; s: string };
const vouchers: Vo[] = V.vouchers;
const filler = (i: number): Vo => ({ k: "ffffffffffffffff", p: "00".repeat(32), n: i.toString(16).padStart(64, "0"), s: "AAAA" });
const pick = (r: number | string): Vo => (r === "forged" ? V.forged : r === "otherKey" ? V.otherKey : vouchers[r as number]!);

describe("webapp voucher link: shared vectors", () => {
  it("encodes the links byte for byte", () => {
    expect(L.VOUCHER_LINK_PATH).toBe(V.path);
    expect(L.VOUCHER_LINK_MAX_PER_LINK).toBe(V.maxPerLink);
    expect(L.encodeVoucherLinks(vouchers.slice(0, 3), V.apex)).toEqual(V.links.single);
    expect(L.encodeVoucherLinks(vouchers, V.apex)).toEqual(V.links.chunked);
    expect(L.encodeVoucherLinkPayload([vouchers[0]!], 1, 1)).toBe(V.payloadOneVoucher);
  });

  for (const c of V.parse) {
    it(`parses: ${c.name}`, () => {
      const r = L.parseVoucherLink(c.link);
      if (c.expect.ok) {
        expect(r.ok).toBe(true);
        expect({ part: r.part, parts: r.parts, keyId: r.keyId, count: r.vouchers.length }).toEqual({
          part: c.expect.part,
          parts: c.expect.parts,
          keyId: c.expect.keyId,
          count: c.expect.count,
        });
        expect(r.vouchers.map(W.voucherNullifier)).toEqual(c.expect.nullifiers);
      } else {
        expect(r).toEqual({ ok: false, code: c.expect.code });
      }
    });
  }

  for (const c of V.imports) {
    it(`plans an import: ${c.name}`, () => {
      const w = W.emptyVoucherWallet(10);
      w.vouchers = [...c.wallet.vouchers.map((i: number) => vouchers[i]!), ...Array.from({ length: c.wallet.filler ?? 0 }, (_, i) => filler(i))];
      w.spent = c.wallet.spent.map((i: number) => W.voucherNullifier(vouchers[i]!));
      const p = L.planVoucherLinkImport(w, c.link.map(pick), c.keys === "test" ? [V.key] : []);
      expect({ ...p, add: p.add.map((v: Vo) => vouchers.findIndex((x) => x.n === v.n && x.s === v.s)) }).toEqual(c.expect);
    });
  }
});

describe("webapp voucher link: the page's own link", () => {
  const session = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it("keeps an /app/vouchers link for after the unlock and clears the address bar", () => {
    const frag = V.links.single[0].split("#")[1];
    const replaced: string[] = [];
    const s = session();
    const got = L.stashVoucherLinkFromLocation(
      { pathname: "/app/vouchers", host: "webapp.flagshipserver.com", hash: `#${frag}` } as Location,
      { replaceState: (_a: unknown, _b: string, url: string) => void replaced.push(url) } as unknown as History,
      s as unknown as Storage,
    );
    expect(got).toBe(`https://webapp.flagshipserver.com/app/vouchers#${frag}`);
    expect(replaced).toEqual(["/"]);
    const taken = L.takePendingVoucherLink(s as unknown as Storage);
    expect(L.parseVoucherLink(taken!).ok).toBe(true);
    expect(L.takePendingVoucherLink(s as unknown as Storage)).toBeNull();
  });

  it("leaves any other page alone", () => {
    const s = session();
    expect(L.stashVoucherLinkFromLocation({ pathname: "/", host: "x", hash: "#v=abc" } as Location, undefined, s as unknown as Storage)).toBeNull();
    expect(L.takePendingVoucherLink(s as unknown as Storage)).toBeNull();
  });
});

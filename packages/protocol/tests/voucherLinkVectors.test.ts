import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { voucherNullifier, type Voucher } from "../src/voucher.js";
import {
  encodeVoucherLinkPayload,
  encodeVoucherLinks,
  parseVoucherLink,
  planVoucherLinkImport,
  VOUCHER_LINK_MAX_PER_LINK,
  VOUCHER_LINK_PATH,
} from "../src/voucherLink.js";
import { addVouchers, emptyVoucherWallet } from "../src/voucherWallet.js";

const V = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/voucher-link/vectors.json"), "utf8"));
const vouchers: Voucher[] = V.vouchers;
const filler = (i: number): Voucher => ({ k: "ffffffffffffffff", p: "00".repeat(32), n: i.toString(16).padStart(64, "0"), s: "AAAA" });
const pick = (r: number | string): Voucher => (r === "forged" ? V.forged : r === "otherKey" ? V.otherKey : vouchers[r as number]!);

describe("voucher link vectors", () => {
  it("encodes the links byte for byte", () => {
    expect(V.path).toBe(VOUCHER_LINK_PATH);
    expect(V.maxPerLink).toBe(VOUCHER_LINK_MAX_PER_LINK);
    expect(encodeVoucherLinks(vouchers.slice(0, 3), V.apex)).toEqual(V.links.single);
    expect(encodeVoucherLinks(vouchers, V.apex)).toEqual(V.links.chunked);
    expect(encodeVoucherLinkPayload([vouchers[0]!], 1, 1)).toBe(V.payloadOneVoucher);
  });

  for (const c of V.parse) {
    it(`parses: ${c.name}`, () => {
      const r = parseVoucherLink(c.link);
      if (c.expect.ok) {
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect({ part: r.part, parts: r.parts, keyId: r.keyId, count: r.vouchers.length }).toEqual({
          part: c.expect.part,
          parts: c.expect.parts,
          keyId: c.expect.keyId,
          count: c.expect.count,
        });
        expect(r.vouchers.map(voucherNullifier)).toEqual(c.expect.nullifiers);
      } else {
        expect(r).toEqual({ ok: false, code: c.expect.code });
      }
    });
  }

  it("round-trips every voucher of a chunked purchase exactly", () => {
    const back = V.links.chunked.flatMap((u: string) => {
      const r = parseVoucherLink(u);
      return r.ok ? r.vouchers : [];
    });
    expect(back).toEqual(vouchers);
  });

  for (const c of V.imports) {
    it(`plans an import: ${c.name}`, () => {
      const w = emptyVoucherWallet(10);
      w.vouchers = [...c.wallet.vouchers.map((i: number) => vouchers[i]!), ...Array.from({ length: c.wallet.filler ?? 0 }, (_, i) => filler(i))];
      w.spent = c.wallet.spent.map((i: number) => voucherNullifier(vouchers[i]!));
      const p = planVoucherLinkImport(w, c.link.map(pick), c.keys === "test" ? [V.key] : []);
      expect({ ...p, add: p.add.map((v) => vouchers.findIndex((x) => x.n === v.n && x.s === v.s)) }).toEqual(c.expect);
    });
  }

  it("adding a planned import and opening the link again adds nothing", () => {
    const link = parseVoucherLink(V.links.single[0]);
    if (!link.ok) throw new Error("vector link must parse");
    const first = planVoucherLinkImport(emptyVoucherWallet(10), link.vouchers, [V.key]);
    const w = addVouchers(emptyVoucherWallet(10), first.add);
    const again = planVoucherLinkImport(w, link.vouchers, [V.key]);
    expect(again.outcome).toBe("already");
    expect(again.add).toEqual([]);
  });

  it("splits by key before splitting by size", () => {
    const other = { ...vouchers[0]!, k: "00112233445566ff" };
    const urls = encodeVoucherLinks([vouchers[0]!, other, vouchers[1]!], V.apex);
    expect(urls).toHaveLength(2);
    const a = parseVoucherLink(urls[0]!);
    const b = parseVoucherLink(urls[1]!);
    expect(a.ok && a.vouchers.length === 2 && a.part === 1 && a.parts === 2).toBe(true);
    expect(b.ok && b.keyId === "00112233445566ff" && b.part === 2).toBe(true);
  });

  it("refuses to encode nothing or a bad voucher", () => {
    expect(() => encodeVoucherLinks([], V.apex)).toThrow();
    expect(() => encodeVoucherLinkPayload([{ ...vouchers[0]!, s: "AAAA" }], 1, 1)).toThrow();
  });
});

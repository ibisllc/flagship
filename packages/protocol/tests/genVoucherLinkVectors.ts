// Regenerate test-vectors/voucher-link/vectors.json:
//   npx tsx packages/protocol/tests/genVoucherLinkVectors.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { rsaPrivateKeyFromJwk } from "../src/blindRsa.js";
import { signBlindedVoucher, voucherKeyFromRsa, voucherNullifier, type Voucher } from "../src/voucher.js";
import { batchVoucherRequest } from "../src/voucherBatch.js";
import { finalizeVoucher } from "../src/voucher.js";
import {
  TAG_VOUCHER_LINK,
  encodeVoucherLinkPayload,
  encodeVoucherLinks,
  parseVoucherLink,
  planVoucherLinkImport,
  VOUCHER_LINK_PATH,
} from "../src/voucherLink.js";
import { emptyVoucherWallet, VOUCHER_WALLET_MAX_VOUCHERS } from "../src/voucherWallet.js";
import { b64Decode, b64Encode } from "../src/webEnvelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../test-vectors/voucher-link");
mkdirSync(dir, { recursive: true });
const keyFile = JSON.parse(readFileSync(join(here, "../test-vectors/vouchers/test-rsa-key.json"), "utf8")) as { jwk: Record<string, string> };
const sk = rsaPrivateKeyFromJwk(keyFile.jwk);
const key = voucherKeyFromRsa(sk);
const apex = "flagshipserver.com";
const seed = new Uint8Array(32).fill(0x42);

const vouchers: Voucher[] = Array.from({ length: 35 }, (_, i) => {
  const req = batchVoucherRequest(key, seed, i);
  return finalizeVoucher(key, req.pending, signBlindedVoucher(sk, req.blinded));
});

const b64url = (b: Uint8Array) => b64Encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => b64Decode(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4))!;
/** Re-seal a payload after editing its body, so only the edit is wrong. */
function reseal(body: Uint8Array): string {
  const tag = new TextEncoder().encode(`${TAG_VOUCHER_LINK}|`);
  const m = new Uint8Array(tag.length + body.length);
  m.set(tag);
  m.set(body, tag.length);
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  out.set(sha256(m).subarray(0, 4), body.length);
  return b64url(out);
}
const url = (payload: string) => `https://${apex}${VOUCHER_LINK_PATH}#v=${payload}`;

const singleUrls = encodeVoucherLinks(vouchers.slice(0, 3), apex);
const chunkedUrls = encodeVoucherLinks(vouchers, apex);
const single = singleUrls[0]!;
const singlePayload = single.split("#v=")[1]!;
const singleBody = fromB64url(singlePayload).slice(0, -4);

const flipAt = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
const edited = (f: (b: Uint8Array) => void) => {
  const b = singleBody.slice();
  f(b);
  return url(reseal(b));
};

const forged: Voucher = (() => {
  const v = vouchers[3]!;
  const s = b64Decode(v.s)!.slice();
  s[10] ^= 0x01;
  return { ...v, s: b64Encode(s) };
})();
const otherKey: Voucher = { ...vouchers[4]!, k: "00112233445566ff" };

const parse = [
  { name: "one link, three vouchers", link: single },
  { name: "the fragment alone", link: `#v=${singlePayload}` },
  { name: "the payload alone, as pasted", link: `v=${singlePayload}` },
  { name: "a trailing slash on the path", link: single.replace("/app/vouchers#", "/app/vouchers/#") },
  { name: "another host (the gym apex)", link: single.replace(apex, "gym.flagshipserver.com") },
  { name: "chunked: part 1 of 2", link: chunkedUrls[0]! },
  { name: "chunked: part 2 of 2", link: chunkedUrls[1]! },
  { name: "truncated (the end cut off)", link: single.slice(0, single.length - 40) },
  { name: "truncated to the header", link: url(singlePayload.slice(0, 12)) },
  { name: "one character changed", link: flipAt(single, single.length - 300) },
  { name: "no fragment", link: `https://${apex}${VOUCHER_LINK_PATH}` },
  { name: "an empty payload", link: `https://${apex}${VOUCHER_LINK_PATH}#v=` },
  { name: "a character outside base64url", link: single.replace("#v=", "#v=+") },
  { name: "another app link", link: single.replace("/app/vouchers", "/app/plan") },
  { name: "a newer version", link: edited((b) => (b[0] = 2)) },
  { name: "version zero", link: edited((b) => (b[0] = 0)) },
  { name: "part past parts", link: edited((b) => ((b[1] = 3), (b[2] = 2))) },
  { name: "count larger than the body", link: edited((b) => (b[11] = 4)) },
  { name: "count above 30", link: edited((b) => (b[11] = 31)) },
  { name: "signature length too small", link: edited((b) => ((b[12] = 0), (b[13] = 255))) },
  { name: "too long", link: url("A".repeat(32_769)) },
].map((c) => {
  const r = parseVoucherLink(c.link);
  return {
    ...c,
    expect: r.ok
      ? { ok: true, part: r.part, parts: r.parts, keyId: r.keyId, count: r.vouchers.length, nullifiers: r.vouchers.map(voucherNullifier) }
      : { ok: false, code: r.code },
  };
});

const fillerVoucher = (i: number): Voucher => ({ k: "ffffffffffffffff", p: "00".repeat(32), n: i.toString(16).padStart(64, "0"), s: "AAAA" });
const ref = (v: Voucher) => vouchers.findIndex((x) => x.k === v.k && x.n === v.n && x.s === v.s);
type ImportCase = { name: string; wallet: { vouchers: number[]; spent: number[]; filler?: number }; link: Array<number | "forged" | "otherKey">; keys: "test" | "none" };
const cases: ImportCase[] = [
  { name: "a fresh wallet takes them all", wallet: { vouchers: [], spent: [] }, link: [0, 1, 2], keys: "test" },
  { name: "the same link opened twice", wallet: { vouchers: [0, 1, 2], spent: [] }, link: [0, 1, 2], keys: "test" },
  { name: "some already in the wallet", wallet: { vouchers: [0, 5], spent: [] }, link: [0, 1, 2], keys: "test" },
  { name: "already spent from this wallet", wallet: { vouchers: [], spent: [0, 1, 2] }, link: [0, 1, 2], keys: "test" },
  { name: "one spent, two new", wallet: { vouchers: [], spent: [1] }, link: [0, 1, 2], keys: "test" },
  { name: "a forged voucher alone", wallet: { vouchers: [], spent: [] }, link: ["forged"], keys: "test" },
  { name: "a forged voucher among good ones", wallet: { vouchers: [], spent: [] }, link: [0, "forged", 1], keys: "test" },
  { name: "a voucher twice in one link", wallet: { vouchers: [], spent: [] }, link: [0, 0, 1], keys: "test" },
  { name: "a key this device has never seen", wallet: { vouchers: [], spent: [] }, link: ["otherKey"], keys: "test" },
  { name: "no keys held yet", wallet: { vouchers: [], spent: [] }, link: [0, 1], keys: "none" },
  { name: "the wallet would pass its limit", wallet: { vouchers: [], spent: [], filler: VOUCHER_WALLET_MAX_VOUCHERS - 2 }, link: [0, 1, 2], keys: "test" },
  { name: "exactly fills the wallet", wallet: { vouchers: [], spent: [], filler: VOUCHER_WALLET_MAX_VOUCHERS - 3 }, link: [0, 1, 2], keys: "test" },
];
const pick = (r: number | "forged" | "otherKey") => (r === "forged" ? forged : r === "otherKey" ? otherKey : vouchers[r]!);
const imports = cases.map((c) => {
  const w = emptyVoucherWallet(10);
  w.vouchers = [...c.wallet.vouchers.map((i) => vouchers[i]!), ...Array.from({ length: c.wallet.filler ?? 0 }, (_, i) => fillerVoucher(i))];
  w.spent = c.wallet.spent.map((i) => voucherNullifier(vouchers[i]!));
  const p = planVoucherLinkImport(w, c.link.map(pick), c.keys === "test" ? [key] : []);
  return {
    ...c,
    expect: { add: p.add.map(ref), duplicate: p.duplicate, spent: p.spent, invalid: p.invalid, unknownKey: p.unknownKey, full: p.full, outcome: p.outcome },
  };
});

const out = {
  about:
    "flagship/voucher-link/v1 (packages/protocol/src/voucherLink.ts, docs/anonymous-vouchers.md \"Voucher links\"). `vouchers` are 35 test vouchers under `key` (test-vectors/vouchers/test-rsa-key.json). `links.single` is encodeVoucherLinks(vouchers[0..3)), `links.chunked` encodeVoucherLinks(all 35) (30 + 5). `parse` cases: expect.ok with part, parts, keyId, count and each voucher's nullifier, or expect.code. `imports`: wallet.vouchers / spent are indexes into `vouchers` (spent as nullifiers), plus `filler` placeholder vouchers {k: \"ffffffffffffffff\", p: 64 zeros, n: i as 64-hex, s: \"AAAA\"} for i in 0..filler; link entries are indexes, \"forged\" (`forged`) or \"otherKey\" (`otherKey`); keys \"test\" = [key], \"none\" = []; expect.add lists indexes.",
  apex,
  path: VOUCHER_LINK_PATH,
  maxPerLink: 30,
  key,
  vouchers,
  forged,
  otherKey,
  links: { single: singleUrls, chunked: chunkedUrls },
  payloadOneVoucher: encodeVoucherLinkPayload([vouchers[0]!], 1, 1),
  parse,
  imports,
};
writeFileSync(join(dir, "vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote", join(dir, "vectors.json"));

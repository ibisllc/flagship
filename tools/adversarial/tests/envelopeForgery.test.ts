/**
 * V01 adversarial suite, ENV slice: forged, stripped and confused signatures on every signed
 * envelope family the protocol package exports (IMPLEMENTATION-PLAN.md §14 "Crypto": invalid
 * signatures, one missing hybrid component, substitution, suite stripping).
 *
 * Boundary: every `verifyX` in packages/protocol/src is the check a box, `.com`, the boot Worker or
 * a client runs before acting on a signed order, grant, report or attestation. A verifier that
 * accepts a forgery is an authority bypass on whatever acts on it.
 *
 * The families are found, not listed: support/envelopeDriver.ts pairs each exported `signX` with
 * its `verifyX`, infers a sample the encoder accepts, and finds the convention under which the
 * PRODUCTION verifier accepts it. Each family then faces:
 *
 *   AT-ENV-01  control: its own signature verifies (proves the attack below is meaningful)
 *   AT-ENV-02  one flipped signature bit is refused            catches: a verifier that skips the check
 *   AT-ENV-03  a signature by another valid key is refused     catches: "any Ed25519 key" verifiers
 *   AT-ENV-04  every field the encoder reads is bound          catches: a field left out of the signed bytes
 *   AT-ENV-05  empty, truncated, all-zero and missing          catches: length/shape bugs that pass
 *   AT-ENV-06  another family's signature is refused           catches: cross-protocol reuse
 *   AT-ENV-07  signed bytes start with a unique purpose tag    catches: two families signing the same bytes
 *   AT-ENV-08  a low-order public key with a zero signature    catches: the all-zero-key forgery
 *   AT-ENV-09  a "|" in one field cannot move into the next    catches: canonical-join ambiguity
 *   AT-ENV-10  inventory: every flagship/<purpose>/vN tag in protocol src is classified here
 *   AT-ENV-11  coverage floor: the harness drives at least the families it drove when written
 *
 * Families the harness cannot drive (nested shapes, enum-heavy validation, envelopes that are not
 * sign/verify pairs, hybrid ML-DSA) are in envelopeForgery.hybrid.test.ts (AT-ENV-20..).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../../../packages/protocol/src/index.js";
import { drive, driveSeeded, getPath, mutate, newKey, setPath, toHex, type DriveFailure, type Family, type TestKey } from "./support/envelopeDriver.js";
import { SEEDS } from "./support/seeds.js";
import { CLASSIFIED_TAGS } from "./support/tagInventory.js";

const api = P as unknown as Record<string, unknown>;
const signNames = Object.keys(api)
  .filter((k) => k.startsWith("sign") && typeof api[k] === "function" && typeof api[`verify${k.slice(4)}`] === "function")
  .sort();

const families: Family[] = [];
const undriven: DriveFailure[] = [];
for (const s of signNames) {
  const name = s.slice(4);
  const seed = SEEDS[name];
  const r = seed ? await driveSeeded(api, s, `verify${name}`, seed) : await drive(api, s, `verify${name}`);
  if ("tag" in r) families.push(r);
  else undriven.push(r);
}

/** The sample as `key` would sign it: a family that names its signer inside the object gets that key. */
function own(f: Family, key: TestKey): Record<string, unknown> {
  if (!f.keyField) return f.sample;
  const cur = f.sample[f.keyField];
  return { ...f.sample, [f.keyField]: typeof cur === "string" ? toHex(key.pub) : key.pub };
}

/**
 * Fields a verifier legitimately does not bind, each reviewed. Anything else that survives a
 * mutation is a finding.
 */
const UNBOUND_OK: Record<string, string> = {
  // Read by the encoder only to strip it (the signature itself travels in the object).
  "*.signature": "the signature field is stripped before encoding",
  "*.signatureHex": "the signature field is stripped before encoding",
  "*.sig": "the signature field is stripped before encoding",
};

function unboundReason(family: string, field: string): string | undefined {
  return UNBOUND_OK[`${family}.${field}`] ?? UNBOUND_OK[`*.${field}`];
}

/** Families whose encoder reads a field but whose verifier still accepted it changed. Reviewed below. */
const KNOWN_UNBOUND: Record<string, string[]> = {};

const flip = (sig: Uint8Array, i = 0) => {
  const c = Uint8Array.from(sig);
  c[i] = c[i]! ^ 0x01;
  return c;
};

describe("AT-ENV generic forgery suite over every driven signX/verifyX pair", () => {
  it("AT-ENV-11 coverage floor: the harness drives at least 165 families (catches: a refactor that silently drops families out of this suite)", () => {
    expect(families.length, `driven ${families.length}; undriven:\n${undriven.map((u) => `${u.name} ${u.stage} ${u.detail}`).join("\n")}`).toBeGreaterThanOrEqual(165);
  });

  describe.each(families.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    const key = newKey(2);
    const other = newKey(3);
    const sample = own(f, key);
    const { sig } = f.sign(sample, key);

    it(`AT-ENV-01 ${f.tag}: its own signature verifies (control)`, async () => {
      expect(await f.verify(sample, sig, key.pub)).toBe(true);
    });

    it(`AT-ENV-02 ${f.tag}: a signature with one flipped bit is refused (catches: a verifier that skips the signature check)`, async () => {
      expect(await f.verify(sample, flip(sig, 0), key.pub)).toBe(false);
      expect(await f.verify(sample, flip(sig, 63), key.pub)).toBe(false);
    });

    it(`AT-ENV-03 ${f.tag}: a signature by another valid key is refused, and the right signature under another key too (catches: verifiers that accept any Ed25519 key)`, async () => {
      const forged = f.sign(sample, other).sig;
      if (f.keyField) {
        // The family names its signer inside the object: a forger who swaps the named key must be
        // stopped by whoever pins it (outside this function). What must hold here: the object that
        // names the honest key does not verify under the forger's signature.
        expect(await f.verify(sample, forged, key.pub)).toBe(false);
        return;
      }
      expect(await f.verify(sample, forged, key.pub)).toBe(false);
      expect(await f.verify(sample, sig, other.pub)).toBe(false);
    });

    it(`AT-ENV-04 ${f.tag}: changing any field the encoder reads breaks the signature (catches: a field left out of the signed bytes)`, async () => {
      const survived: string[] = [];
      for (const path of f.fields) {
        if (path === f.keyField) continue;
        const before = getPath(sample, path);
        // A field the encoder reads by truthiness (`x ? "1" : "0"`) is bound if ANY change breaks it.
        const alts = [mutate(before), false, true, "", 0, null].filter((a) => a !== before);
        let bound = false;
        for (const alt of alts) {
          if (!(await f.verify(setPath(sample, path, alt), sig, key.pub))) {
            bound = true;
            break;
          }
        }
        if (!bound && !unboundReason(f.name, path)) survived.push(path);
      }
      expect(survived.sort()).toEqual((KNOWN_UNBOUND[f.name] ?? []).sort());
    });

    it(`AT-ENV-05 ${f.tag}: an empty, truncated, all-zero or missing signature is refused (catches: length and shape bugs)`, async () => {
      expect(await f.verify(sample, new Uint8Array(0), key.pub)).toBe(false);
      expect(await f.verify(sample, sig.slice(0, 63), key.pub)).toBe(false);
      expect(await f.verify(sample, new Uint8Array(64), key.pub)).toBe(false);
      expect(await f.verify(sample, undefined as unknown as Uint8Array, key.pub)).toBe(false);
      const longer = new Uint8Array(65);
      longer.set(sig);
      expect(await f.verify(sample, longer, key.pub)).toBe(false);
    });

    it(`AT-ENV-08 ${f.tag}: the all-zero (low-order) public key with a zero signature is refused (catches: the small-order key forgery)`, async () => {
      if (f.keyField) return; // the key comes from the object; covered by AT-ENV-03
      expect(await f.verify(sample, new Uint8Array(64), new Uint8Array(32))).toBe(false);
      const ident = new Uint8Array(32);
      ident[0] = 1; // the identity point
      expect(await f.verify(sample, new Uint8Array(64), ident)).toBe(false);
    });
  });

  it("AT-ENV-06 a signature made for one family is refused by every other family's verifier (catches: cross-protocol signature reuse)", async () => {
    const key = newKey(4);
    const samples = families.map((f) => own(f, key));
    const sigs = families.map((f, i) => f.sign(samples[i]!, key).sig);
    const accepted: string[] = [];
    for (let a = 0; a < families.length; a++) {
      for (let b = 0; b < families.length; b++) {
        if (a === b) continue;
        if (await families[b]!.verify(samples[b]!, sigs[a]!, key.pub)) accepted.push(`${families[a]!.name} -> ${families[b]!.name}`);
      }
    }
    expect(accepted).toEqual([]);
    // ~28k signature checks: about 30 s on a laptop, so it gets its own bound.
  }, 300_000);

  it("AT-ENV-07 every family signs bytes that start with its own flagship/<purpose>/vN tag, and no two families share a tag (catches: two meanings for one signature)", () => {
    const untagged = families.filter((f) => f.tag.startsWith("(untagged")).map((f) => `${f.name}: ${f.tag}`);
    // Reviewed exceptions: domain-separated by a different, unique prefix.
    expect(untagged.map((u) => u.replace(/\|.*$/, "")).sort()).toEqual(UNTAGGED_REVIEWED.sort());
    const byTag = new Map<string, string[]>();
    for (const f of families) byTag.set(f.tag, [...(byTag.get(f.tag) ?? []), f.name]);
    const shared = [...byTag].filter(([, ns]) => ns.length > 1).map(([t, ns]) => `${t}: ${ns.join(", ")}`);
    expect(shared.sort()).toEqual(SHARED_TAGS_REVIEWED.map(([t, ns]) => `${t}: ${ns.join(", ")}`).sort());
    // A family that shares a tag must still never produce the same bytes as its sibling.
    for (const [t, ns] of SHARED_TAGS_REVIEWED) {
      const fs = families.filter((f) => f.tag === t && ns.includes(f.name));
      const texts = fs.map((f) => toHex(f.signed));
      expect(new Set(texts).size, t).toBe(texts.length);
    }
  });

  it("AT-ENV-09 a separator in one text field cannot shift into the next and keep the signature valid (catches: canonical-join ambiguity)", async () => {
    const key = newKey(5);
    const ambiguous: string[] = [];
    for (const f of families) {
      const strFields = f.fields.filter((p) => !p.includes(".") && p !== f.keyField && typeof f.sample[p] === "string");
      for (let i = 0; i + 1 < strFields.length; i++) {
        const a = strFields[i]!;
        const b = strFields[i + 1]!;
        const va = f.sample[a] as string;
        const vb = f.sample[b] as string;
        const o1 = { ...f.sample, [a]: `${va}|${vb}`, [b]: vb };
        const o2 = { ...f.sample, [a]: va, [b]: `${vb}|${vb}` };
        let s1, s2;
        try {
          s1 = f.sign(own({ ...f, sample: o1 }, key), key);
          s2 = f.sign(own({ ...f, sample: o2 }, key), key);
        } catch {
          continue; // the encoder refuses a separator in a field: safe
        }
        if (toHex(s1.signed) === toHex(s2.signed)) ambiguous.push(`${f.name}.${a}/${b}`);
        // and the signature for one never verifies the other
        if (await f.verify(own({ ...f, sample: o2 }, key), s1.sig, key.pub)) ambiguous.push(`${f.name}.${a}/${b} (cross-verify)`);
      }
    }
    expect(ambiguous).toEqual(KNOWN_AMBIGUOUS);
  });
});

/**
 * Families signed under a prefix other than flagship/<purpose>/vN, reviewed: each prefix is still
 * unique to its family (the peer-backup v1 messages predate the convention; the CA binding uses its
 * own CA-domain prefix).
 */
const UNTAGGED_REVIEWED = [
  "PbAnnounce: (untagged:pb/announce/v1",
  "PbPeerConfirm: (untagged:pb/peer-confirm/v1",
  "PbRequestPeers: (untagged:pb/request-peers/v1",
  "UserPubKeyBinding: (untagged:flagship-ca-binding/v1",
];

/**
 * Families that share a tag on purpose (one canonical shape, two signer roles, or a family whose
 * sign and verify were exported under two names). Reviewed: their bytes still differ (AT-ENV-07).
 */
const SHARED_TAGS_REVIEWED: [string, string[]][] = [];

/**
 * Field pairs where a "|" used to move between fields with the signed bytes staying equal (AT-ENV-09a..f,
 * fixed: each encoder now refuses '|' and control characters in its text fields and requires integers
 * in its numeric ones). Kept as regression tests below; the aggregate test fails on any ambiguity.
 */
const FINDINGS_09: [string, string, string][] = [
  ["LlmPromoIssue", "provider", "desiredDailyInputTokenCap"],
  ["LlmPromoIssue", "desiredDailyInputTokenCap", "desiredDailyOutputTokenCap"],
  ["PbManifestDeposit", "ciphertextSha256Hex", "nonceHex"],
  ["ProvisionEvent", "serverDomain", "phase"],
  ["PublisherTrust", "oldKeyHex", "newKeyHex"],
  ["PushRelayRequest", "targetUsername", "category"],
];
const KNOWN_AMBIGUOUS: string[] = [];

describe("AT-ENV-09 regressions: canonical-join ambiguity, one per family (fixed)", () => {
  // AT-ENV-09a..f (fixed): these encoders joined fields with "|" without refusing "|" inside them, so
  //   {a: "x|y", b: "z"} and {a: "x", b: "y|z"} produced the SAME signed bytes and one signature verified
  // both. Each now refuses '|' and control characters in its text fields (legacyFieldGuard) and requires
  // safe integers in its numeric fields (integerFieldGuard): llmPromo.ts canonicalLlmPromoIssue,
  // peerBackupManifest.ts canonicalPbManifestDeposit, provisioning.ts canonicalProvisionEvent,
  // appRelease.ts canonicalPublisherTrust, pushRelay.ts canonicalPushRelayRequest. The webapp, Swift,
  // Kotlin and Rust ports of the two cross-port families refuse the same (test-vectors `refuse` lists).
  const ids = "abcdef";
  FINDINGS_09.forEach(([fam, a, b2], i) => {
    it(`AT-ENV-09${ids[i]} ${fam}: "${a}" and "${b2}" cannot trade a "|" under one signature (catches: canonical-join ambiguity)`, async () => {
      const f = families.find((x) => x.name === fam)!;
      const key = newKey(6);
      const va = String(f.sample[a]);
      const vb = String(f.sample[b2]);
      const o1 = own({ ...f, sample: { ...f.sample, [a]: `${va}|${vb}`, [b2]: vb } }, key);
      const o2 = own({ ...f, sample: { ...f.sample, [a]: va, [b2]: `${vb}|${vb}` } }, key);
      let s1;
      try {
        s1 = f.sign(o1, key);
      } catch {
        return; // fixed: the encoder refuses the separator
      }
      expect(await f.verify(o2, s1.sig, key.pub)).toBe(false);
    });
  });
});

describe("AT-ENV-10 tag inventory", () => {
  it("AT-ENV-10 every flagship/<purpose>/vN string in packages/protocol/src is classified (driven, bespoke-tested, or reviewed as not a signature) (catches: a new signed family that no forgery test covers)", () => {
    const dir = join(import.meta.dirname, "../../../packages/protocol/src");
    const found = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.matchAll(/["'`](flagship\/[a-z0-9._${}-]+(?:\/[a-z0-9._${}-]+)*\/v\d+)/gi)) found.add(m[1]!);
    }
    const driven = new Set(families.map((f) => f.tag));
    const missing = [...found].filter((t) => !driven.has(t) && !(t in CLASSIFIED_TAGS)).sort();
    expect(missing, "classify each new tag in tools/adversarial/tests/support/tagInventory.ts").toEqual([]);
    // and the classification does not rot: every classified tag still exists
    const stale = Object.keys(CLASSIFIED_TAGS).filter((t) => !found.has(t)).sort();
    expect(stale).toEqual([]);
  });
});

/**
 * Shared vectors for deleting a conversation and the caller's reveal (packages/protocol/src/voiciConversation.ts).
 * Read by TS (packages/protocol/tests/voiciConversationVectors.test.ts) and, as their ports land, the webapp, Swift
 * and Kotlin.
 *
 *   npx tsx tools/voici-conversation-vectors.ts          write
 *   npx tsx tools/voici-conversation-vectors.ts --check  exit 1 when stale
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import * as P from "../packages/protocol/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "packages/protocol/test-vectors/voici-conversation/vectors.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/messages/vectors.json"), "utf8"));
const D = M.derivations;
const h = (s: string) => P.hexToBytes(s);
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code!);
type O = Record<string, unknown>;
const tweak = <T>(x: T, f: (o: O) => void): O => {
  const c = clone(x) as unknown as O;
  f(c);
  return c;
};
const NOW = M.t0 + 30_000;
const PAGE_ID: string = D.pageId;
const ORIGIN = P.VOICI_WEB_ORIGIN;
const expectAll = (name: string, cases: [string, unknown, string][], run: (i: unknown) => string) =>
  cases.map(([n, input, expect]) => {
    const got = run(input);
    if (got !== expect) throw new Error(`${name} "${n}": ${got} != ${expect}`);
    return { name: n, input, expect };
  });

// ── delete ──
const base = { pageId: PAGE_ID, conv: D.conv, issuedAt: NOW };
const byOwner = P.signVoiciConvDeleteOwner(base, h(D.ownerSignSeed));
const byApp = P.signVoiciConvDeletePseudonym(base, h(D.pseudonymSeed));
const byBrowser = P.signVoiciConvDeleteBrowserP256(base, D.pseudonymPub, clone(M.message.envelope.cred), h(M.keys.browserPriv));
const delCtx = { pageId: PAGE_ID, ownerSignPub: D.ownerSignPub, origin: ORIGIN, caKeys: [M.keys.caPub], now: NOW };
const deleteChecks = expectAll(
  "delete",
  [
    ["owner", byOwner, "ok"],
    ["caller's app", byApp, "ok"],
    ["caller's browser", byBrowser, "ok"],
    ["extra key", tweak(byOwner, (o) => (o.extra = 1)), "malformed"],
    ["owner's delete claimed as the caller's", tweak(byOwner, (o) => ((o.del as O).side = "caller")), "wrong-side"],
    ["caller's delete by the owner key", tweak(P.signVoiciConvDeleteOwner(base, h(D.ownerSignSeed)), (o) => ((o.del as O).side = "caller")), "wrong-side"],
    ["conversation swapped after signing", tweak(byOwner, (o) => ((o.del as O).conv = "ab".repeat(32))), "bad-signature"],
    ["another pseudonym's conversation", tweak(byApp, (o) => (o.from = D.otherPagePseudonymPub)), "wrong-conv"],
    ["signed by the pseudonym as the owner", { del: { ...base, side: "owner" }, signer: "owner", sig: H(P.ed.sign(P.canonicalVoiciConvDelete({ ...base, side: "owner" }), h(D.pseudonymSeed))) }, "bad-signature"],
    ["another page", tweak(byOwner, (o) => ((o.del as O).pageId = "ab".repeat(16))), "wrong-audience"],
    ["stale", P.signVoiciConvDeleteOwner({ ...base, issuedAt: NOW - 11 * 60_000 }, h(D.ownerSignSeed)), "stale"],
    ["browser delete by another browser key", tweak(byBrowser, (o) => (o.sig = H(p256.sign(P.canonicalVoiciConvDelete({ ...base, side: "caller" }), new Uint8Array(32).fill(0x63), { lowS: true })))), "bad-signature"],
    ["browser delete with a forged delegation", tweak(byBrowser, (o) => ((o.cred as O).delegationSig = "00".repeat(64))), "bad-delegation"],
    ["uppercase conversation", tweak(byOwner, (o) => ((o.del as O).conv = String(D.conv).toUpperCase())), "malformed"],
  ],
  (i) => code(P.checkVoiciConvDelete(i, delCtx)),
);

// ── reveal ──
const callerSeed = h(D.ownerSignSeed); // the caller's own page key (any Ed25519 page key; the owner app checks against what .com serves)
const callerPub = H(P.ed.getPublicKey(callerSeed));
const reveal = P.signVoiciReveal({ conv: D.conv, username: "bob", displayName: "Bob Rivera", issuedAt: NOW }, callerSeed);
const revealNoName = P.signVoiciReveal({ conv: D.conv, username: "bob", displayName: null, issuedAt: NOW }, callerSeed);
const unreveal: P.VoiciUnreveal = { v: 1, kind: "voici-unreveal", conv: D.conv, issuedAt: NOW + 1 };
const revCtx = { conv: D.conv, pageSignPub: callerPub };
const revealChecks = expectAll(
  "reveal",
  [
    ["ok", reveal, "ok"],
    ["no display name", revealNoName, "ok"],
    ["display name swapped after signing", tweak(reveal, (o) => (o.displayName = "Alice Martin")), "bad-signature"],
    ["display name dropped after signing", tweak(reveal, (o) => (o.displayName = null)), "bad-signature"],
    ["username swapped after signing", tweak(reveal, (o) => (o.username = "alice")), "bad-signature"],
    ["another conversation", P.signVoiciReveal({ conv: "ab".repeat(32), username: "bob", displayName: null, issuedAt: NOW }, callerSeed), "wrong-conv"],
    ["signed by another page key", P.signVoiciReveal({ conv: D.conv, username: "bob", displayName: "Bob Rivera", issuedAt: NOW }, h(D.pseudonymSeed)), "bad-signature"],
    ["extra key", tweak(reveal, (o) => (o.extra = 1)), "malformed"],
    ["display name with a newline", tweak(reveal, (o) => (o.displayName = "Bob\nRivera")), "malformed"],
    ["empty display name", tweak(reveal, (o) => (o.displayName = "")), "malformed"],
    ["username uppercase", tweak(reveal, (o) => (o.username = "Bob")), "malformed"],
    ["an unreveal is not a reveal", unreveal, "malformed"],
  ],
  (i) => code(P.checkVoiciReveal(i, revCtx)),
);
const unrevealShapes = [
  { name: "ok", input: unreveal, expect: true },
  { name: "with a signature", input: { ...unreveal, sig: "00".repeat(64) }, expect: false },
  { name: "short conv", input: { ...unreveal, conv: "ab" }, expect: false },
];
for (const c of unrevealShapes) if ((P.parseVoiciRevealControl(c.input) !== null) !== c.expect) throw new Error(`unreveal ${c.name}`);

const doc = {
  description: "Deleting a voi.ci conversation and the caller's reveal (docs/voici-calls.md). Generated by tools/voici-conversation-vectors.ts.",
  now: NOW,
  pageId: PAGE_ID,
  conv: D.conv,
  ownerSignPub: D.ownerSignPub,
  delete: { ctx: delCtx, owner: byOwner, app: byApp, browser: byBrowser, canonical: new TextDecoder().decode(P.canonicalVoiciConvDelete(byOwner.del)), checks: deleteChecks },
  reveal: { pageSignSeed: H(callerSeed), pageSignPub: callerPub, signed: reveal, noName: revealNoName, canonical: new TextDecoder().decode(P.canonicalVoiciReveal(reveal)), nameHash: P.voiciRevealNameHash("Bob Rivera"), ctx: revCtx, checks: revealChecks, unreveal, unrevealShapes },
};
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(OUT, "utf8");
  } catch {
    /* missing */
  }
  if (cur !== text) {
    console.error(`${OUT} is stale; run npx tsx tools/voici-conversation-vectors.ts`);
    process.exit(1);
  }
  console.log("voici-conversation vectors up to date");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${text.length} bytes)`);
}

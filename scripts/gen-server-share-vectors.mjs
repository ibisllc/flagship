#!/usr/bin/env node
// Writes packages/protocol/test-vectors/server-share/vectors.json from the
// TS reference (docs/share-a-server.md). Build the protocol package first:
//   npx tsc -b packages/protocol && node scripts/gen-server-share-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/server-share/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);

const umkA = { seed: fill(32, 0x2a) };
const umkB = { seed: fill(32, 0x5b) };
const ownerKey = P.deriveIRK(umkA);
const otherKey = P.deriveIRK({ seed: fill(32, 0x77) });
const shareId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const member = P.deriveShareMemberKey(umkB, shareId);
const inbox = P.deriveShareInboxKey(umkB);
const memberPubHex = hex(member.publicKey);
const token = P.shareTokenFromSecret(secret);
const linkKey = P.shareLinkKey(secret);
const serverDomain = "home.harry.flagship.services";
const t0 = 1_760_000_000_000;

const keys = {
  ownerUmkSeedHex: hex(umkA.seed),
  ownerSignerPub: hex(ownerKey.publicKey),
  otherSignerPub: hex(otherKey.publicKey),
  memberUmkSeedHex: hex(umkB.seed),
  shareId,
  secretHex: hex(secret),
  memberPubHex,
  inboxPubHex: hex(inbox.publicKey),
  inboxSealKeyHex: hex(P.deriveShareInboxSealKey(umkB)),
  token,
  tokenHash: P.shareTokenHash(token),
  linkKeyHex: hex(linkKey),
  householdKeyHex: hex(P.deriveHouseholdKey(umkA)),
  sas: P.shareSas(shareId, memberPubHex, secret),
  sasFormatted: P.formatShareSas(P.shareSas(shareId, memberPubHex, secret)),
};

// Each case: kind, signer ("owner" | "member" | "inbox"), fields, canonical, signature.
const signers = { owner: ownerKey, member, inbox };
const grant = {
  serverDomain,
  shareId,
  memberPubHex,
  level: "view",
  unlockAtBoot: false,
  seeAppData: false,
  label: "Sam",
  issuedAt: t0,
};
const offerSealed = "00".repeat(40);
const ownerSealed = "11".repeat(40);
const defs = [
  ["grant", "owner", grant],
  ["grant", "owner", { ...grant, level: "manage", unlockAtBoot: true, seeAppData: true, label: "Grandma Rose 🌹", issuedAt: t0 + 1 }],
  ["revoke", "owner", { serverDomain, shareId, issuedAt: t0 + 2 }],
  ["accept", "member", { serverDomain, shareId, memberPubHex, acceptedAt: t0 + 3 }],
  ["leave", "member", { serverDomain, shareId, memberPubHex, issuedAt: t0 + 4 }],
  ["session", "member", { serverDomain, shareId, memberPubHex, nonceHex: "ab".repeat(32), issuedAt: t0 + 5 }],
  [
    "offer",
    "owner",
    {
      username: "harry",
      serverDomain,
      shareId,
      tokenHash: keys.tokenHash,
      offerSha256: P.shareSha256Hex(offerSealed),
      ownerSha256: P.shareSha256Hex(ownerSealed),
      expiresAt: t0 + P.SHARE_OFFER_TTL_MS,
      issuedAt: t0 + 6,
    },
  ],
  ["list", "owner", { username: "harry", issuedAt: t0 + 7 }],
  ["unlock", "owner", { serverDomain, shareId, memberPubHex, sealedSha256: P.shareSha256Hex("cd".repeat(80)), issuedAt: t0 + 8 }],
  ["unlock", "owner", { serverDomain, shareId, memberPubHex, sealedSha256: "off", issuedAt: t0 + 9 }],
  ["inbox", "inbox", { inboxPubHex: keys.inboxPubHex, op: "put", entryId: "a1".repeat(16), ctSha256: P.shareSha256Hex("ef".repeat(50)), issuedAt: t0 + 10 }],
  ["inbox", "inbox", { inboxPubHex: keys.inboxPubHex, op: "list", entryId: "", ctSha256: "", issuedAt: t0 + 11 }],
  ["inbox", "inbox", { inboxPubHex: keys.inboxPubHex, op: "delete", entryId: "a1".repeat(16), ctSha256: "", issuedAt: t0 + 12 }],
];
const canon = {
  grant: P.serverShareGrantCanonicalBytes,
  revoke: P.serverShareRevokeCanonicalBytes,
  accept: P.serverShareAcceptCanonicalBytes,
  leave: P.serverShareLeaveCanonicalBytes,
  session: P.serverShareSessionCanonicalBytes,
  offer: P.serverShareOfferCanonicalBytes,
  list: P.serverShareListCanonicalBytes,
  unlock: P.serverShareUnlockCanonicalBytes,
  inbox: P.shareInboxRequestCanonicalBytes,
};
const envelopes = defs.map(([kind, signer, fields]) => {
  const bytes = canon[kind](fields);
  return {
    kind,
    signer,
    fields,
    canonical: new TextDecoder().decode(bytes),
    signature: hex(P.ed.sign(bytes, signers[signer].privateKey)),
  };
});

// Builders must refuse every one of these (throw / return null when parsing).
const refuse = [
  ["grant", "level is not view or manage", { ...grant, level: "admin" }],
  ["grant", "label carries the separator", { ...grant, label: "Sam|owner" }],
  ["grant", "label is empty", { ...grant, label: "" }],
  ["grant", "label is not trimmed", { ...grant, label: " Sam" }],
  ["grant", "label has a control character", { ...grant, label: "Sa\nm" }],
  ["grant", "label is longer than 64 code points", { ...grant, label: "x".repeat(65) }],
  ["grant", "shareId is uppercase", { ...grant, shareId: shareId.toUpperCase() }],
  ["grant", "shareId is too short", { ...grant, shareId: shareId.slice(2) }],
  ["grant", "memberPubHex is not 64 hex", { ...grant, memberPubHex: memberPubHex.slice(2) }],
  ["grant", "serverDomain is empty", { ...grant, serverDomain: "" }],
  ["grant", "serverDomain carries the separator", { ...grant, serverDomain: "a|b" }],
  ["grant", "issuedAt is negative", { ...grant, issuedAt: -1 }],
  ["session", "nonce is not 64 hex", { serverDomain, shareId, memberPubHex, nonceHex: "ab", issuedAt: t0 }],
  ["unlock", "sealedSha256 is neither hex nor off", { serverDomain, shareId, memberPubHex, sealedSha256: "on", issuedAt: t0 }],
  ["inbox", "list carries an entryId", { inboxPubHex: keys.inboxPubHex, op: "list", entryId: "a1".repeat(16), ctSha256: "", issuedAt: t0 }],
  ["inbox", "put has no ctSha256", { inboxPubHex: keys.inboxPubHex, op: "put", entryId: "a1".repeat(16), ctSha256: "", issuedAt: t0 }],
  ["inbox", "delete carries a ctSha256", { inboxPubHex: keys.inboxPubHex, op: "delete", entryId: "a1".repeat(16), ctSha256: "ab".repeat(32), issuedAt: t0 }],
  ["inbox", "op is unknown", { inboxPubHex: keys.inboxPubHex, op: "wipe", entryId: "a1".repeat(16), ctSha256: "", issuedAt: t0 }],
].map(([kind, why, fields]) => {
  let threw = false;
  try {
    canon[kind](fields);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`refuse case did not throw: ${why}`);
  return { kind, why, fields };
});

// A valid signature that must NOT verify: the fields or the key changed.
const g0 = envelopes[0];
const reject = [
  { why: "signed by a key that is not the owner's", kind: "grant", fields: grant, signature: hex(P.ed.sign(canon.grant(grant), otherKey.privateKey)), pub: "owner" },
  { why: "level escalated after signing", kind: "grant", fields: { ...grant, level: "manage" }, signature: g0.signature, pub: "owner" },
  { why: "unlock opt-in turned on after signing", kind: "grant", fields: { ...grant, unlockAtBoot: true }, signature: g0.signature, pub: "owner" },
  { why: "app-data opt-in turned on after signing", kind: "grant", fields: { ...grant, seeAppData: true }, signature: g0.signature, pub: "owner" },
  { why: "grant moved to another server", kind: "grant", fields: { ...grant, serverDomain: "media.harry.flagship.services" }, signature: g0.signature, pub: "owner" },
  { why: "the member signed a grant for themself", kind: "grant", fields: grant, signature: hex(P.ed.sign(canon.grant(grant), member.privateKey)), pub: "owner" },
  {
    why: "an accept signature replayed as a leave",
    kind: "leave",
    fields: { serverDomain, shareId, memberPubHex, issuedAt: t0 + 3 },
    signature: envelopes[3].signature,
    pub: "member",
  },
];
for (const r of reject) {
  if (P.ed.verify(Buffer.from(r.signature, "hex"), canon[r.kind](r.fields), r.pub === "owner" ? ownerKey.publicKey : member.publicKey)) {
    throw new Error(`reject case verifies: ${r.why}`);
  }
}

// Sealed JSON: the exact plaintext string, a fixed nonce, the result.
const sealCase = (name, key, aadPrefix, id, plaintext, nonceByte) => {
  const nonce = fill(12, nonceByte);
  const aad = P.shareAad(aadPrefix, id);
  const sealed = P.sealShareJson(key, aad, JSON.parse(plaintext), nonce);
  return { name, keyHex: hex(key), aad: new TextDecoder().decode(aad), plaintext, nonceHex: hex(nonce), sealed };
};
const offerPlain = JSON.stringify({
  v: 1,
  serverDomain,
  serverName: "home",
  stkPubHex: "cd".repeat(32),
  level: "manage",
  unlockAtBoot: true,
  seeAppData: false,
  expiresAt: t0 + P.SHARE_OFFER_TTL_MS,
});
const acceptPlain = JSON.stringify({ v: 1, accept: envelopes[3].fields, signature: envelopes[3].signature });
const ownerPlain = JSON.stringify({ v: 1, secretHex: hex(secret), label: "Sam", level: "manage", unlockAtBoot: true, seeAppData: false });
const inboxPlain = JSON.stringify({ v: 1, shareId, secretHex: hex(secret), serverDomain, serverName: "home", acceptedAt: t0 + 3 });
const sealed = [
  sealCase("offer", linkKey, P.AAD_SHARE_OFFER, shareId, offerPlain, 1),
  sealCase("acceptance", linkKey, P.AAD_SHARE_ACCEPTANCE, shareId, acceptPlain, 2),
  sealCase("owner", P.deriveHouseholdKey(umkA), P.AAD_SHARE_OWNER, shareId, ownerPlain, 3),
  sealCase("inbox", P.deriveShareInboxSealKey(umkB), P.AAD_SHARE_INBOX_ENTRY, "a1".repeat(16), inboxPlain, 4),
];

const link = P.buildShareLink("https://flagshipserver.com", shareId, secret);
const links = {
  build: { apex: "https://flagshipserver.com", shareId, secretHex: hex(secret), link },
  parse: [
    { in: link, out: { shareId, secretHex: hex(secret) } },
    { in: `flagship://share?s=${shareId}&k=${hex(secret)}`, out: { shareId, secretHex: hex(secret) } },
    { in: `  s=${shareId}&k=${hex(secret)}  `, out: { shareId, secretHex: hex(secret) } },
    { in: `https://flagshipserver.com/share#k=${hex(secret).toUpperCase()}&s=${shareId}`, out: { shareId, secretHex: hex(secret) } },
    { in: `https://flagshipserver.com/invite#s=${shareId}&k=${hex(secret)}`, out: null },
    { in: `https://flagshipserver.com/share?s=${shareId}&k=${hex(secret)}`, out: null },
    { in: `https://flagshipserver.com/share#s=${shareId}`, out: null },
    { in: `https://flagshipserver.com/share#s=${shareId}&k=${hex(secret).slice(2)}`, out: null },
    { in: "flagship://join?sid=x&pk=y", out: null },
  ],
};
for (const c of links.parse) {
  if (JSON.stringify(P.parseShareLink(c.in)) !== JSON.stringify(c.out)) throw new Error(`link case mismatch: ${c.in}`);
}

const doc = {
  about:
    "Share this server (docs/share-a-server.md). Every platform must: derive every value in `keys` from the two UMK seeds and the secret; build each envelope's canonical string from `fields` and reproduce the Ed25519 signature with the named signer (owner = IRK of ownerUmkSeedHex standing in for the sensitive key, member = deriveShareMemberKey(memberUmk, shareId), inbox = deriveShareInboxKey(memberUmk)); refuse every `refuse` case; fail to verify every `reject` case against the named public key; AES-256-GCM-seal each `sealed` plaintext (exact UTF-8 bytes) with the key, nonce and AAD to the given hex, and open it back; build and parse the links. Label length counts Unicode code points.",
  keys,
  envelopes,
  refuse,
  reject,
  sealed,
  links,
};
const text = `${JSON.stringify(doc, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(out, "utf8");
  } catch {}
  if (cur !== text) {
    console.error(`${out} is stale: run node scripts/gen-server-share-vectors.mjs`);
    process.exit(1);
  }
  console.log("server-share vectors up to date");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}

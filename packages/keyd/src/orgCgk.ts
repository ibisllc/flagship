/**
 * keyd adopting a rotated org CGK (docs/enterprise-accounts.md §5.4, §8; "keyd and the org CGK").
 *
 * Under keyd the daemon never holds the CGK, so it cannot re-key gossip itself after an offboarding
 * rotation. keyd changes its CGK only on evidence it verifies itself, never on the daemon's or
 * `.com`'s word:
 *
 *  - the org it belongs to is pinned in keyd's state (`org.json`: orgId, genesis hash, this box's
 *    domain and the CGK version it holds), set once with the boot ceremony's token;
 *  - the daemon hands keyd the org's authority chain from genesis, the key-ring version, and the key
 *    it opened with the box's X-Wing key;
 *  - keyd replays the chain under a narrower rule than the box's full verifier: the genesis (every
 *    admin consents) and `direct` transitions only (k_gov of the previous record's admins, the
 *    strictest threshold for a bylaws or founder change, newcomers' consent). A chain that moved by
 *    a founder's removal, a recovery or an overturn is refused: the box keeps its CGK until the next
 *    boot ceremony. keyd does not see freezes, so a frozen admin's approval still counts here;
 *  - the version is a `cgk` ring above the one keyd holds, names this box among its recipients,
 *    carries one approval by an org admin of the record it names, and the key matches its
 *    commitment;
 *  - the approval stands under the newest record keyd is shown (05c review F4): every signer is still
 *    an org admin there with the same keys, and an approval under an older record was made before the
 *    record after it existed;
 *  - keyd keeps the chain head it last verified (`oarVersion`, `oarHash`) and refuses a chain that
 *    ends below it or forks from it, so a truncated chain cannot bring back a removed admin; and the
 *    hash of the ring it holds, so the next version must link to it (`prevSha256`).
 *
 * The Rust backend (`rust/crates/flagship-keyd/src/org_cgk.rs`) implements the same rule and both
 * read `packages/protocol/test-vectors/keyd-org-cgk/vectors.json`.
 */
import {
  canonicalOrgApproval,
  canonicalOrgAuthority,
  canonicalOrgBylaws,
  canonicalOrgKeyRing,
  checkOrgAuthorityShape,
  hybridVerify,
  orgAuthorityHash,
  orgBylawsThreshold,
  orgKeyCommitment,
  orgKeyRecipientsHash,
  orgSha256Hex,
  pqBindingPublicKey,
  pqKeyId,
  messagePurpose,
  canonicalPqKeyBinding,
  SUITE_HYBRID_SIG_ED25519_MLDSA65_V1,
  TAG_ORG_APPROVAL,
  TAG_ORG_KEY_RING,
  TAG_PQ_KEY_BINDING,
  ORG_APPROVAL_MAX_LIFETIME_MS,
  ORG_GENESIS_PREV,
  ORG_MAX_SKEW_MS,
  type OrgAuthorityRecord,
  type OrgKeyRing,
  type OrgKeyRecipient,
} from "@flagship/protocol";

export interface OrgCgkPin {
  orgId: string;
  genesisHash: string;
  serverDomain: string;
  /** The org CGK version keyd holds; only a higher one is adopted. */
  cgkVersion: number;
  /** The newest authority record keyd verified (version and hash): a later chain must reach it unchanged. */
  oarVersion?: number;
  oarHash?: string;
  /** SHA-256 of the canonical ring keyd holds: the next version must name it as `prevSha256`. */
  cgkRingSha256?: string;
}

export class OrgCgkError extends Error {
  constructor(readonly code: string, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const fail = (code: string, detail = ""): never => {
  throw new OrgCgkError(code, detail);
};
const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const isUint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const obj = (v: unknown, what: string): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : fail("malformed", what);

export function checkOrgCgkPin(v: unknown): OrgCgkPin {
  const o = obj(v, "pin");
  if (typeof o.orgId !== "string" || !HEX16.test(o.orgId)) fail("malformed", "orgId");
  if (typeof o.genesisHash !== "string" || !HEX32.test(o.genesisHash)) fail("malformed", "genesisHash");
  if (typeof o.serverDomain !== "string" || !DOMAIN.test(o.serverDomain)) fail("malformed", "serverDomain");
  if (!isUint(o.cgkVersion)) fail("malformed", "cgkVersion");
  if ((o.oarVersion === undefined) !== (o.oarHash === undefined)) fail("malformed", "oarVersion and oarHash");
  if (o.oarVersion !== undefined && !isUint(o.oarVersion)) fail("malformed", "oarVersion");
  if (o.oarHash !== undefined && (typeof o.oarHash !== "string" || !HEX32.test(o.oarHash))) fail("malformed", "oarHash");
  if (o.cgkRingSha256 !== undefined && (typeof o.cgkRingSha256 !== "string" || !HEX32.test(o.cgkRingSha256))) fail("malformed", "cgkRingSha256");
  return {
    orgId: o.orgId as string,
    genesisHash: o.genesisHash as string,
    serverDomain: o.serverDomain as string,
    cgkVersion: o.cgkVersion as number,
    ...(o.oarVersion !== undefined ? { oarVersion: o.oarVersion as number, oarHash: o.oarHash as string } : {}),
    ...(o.cgkRingSha256 !== undefined ? { cgkRingSha256: o.cgkRingSha256 as string } : {}),
  };
}

interface Key {
  pk: Uint8Array;
  keyId: string;
}

interface Approval {
  orgId: string;
  oarVersion: number;
  purposeTag: string;
  orderSha256: string;
  seatId: string;
  adminKeyId: string;
  notAfter: number;
  issuedAt: number;
  signature: string;
}

const APPROVAL_KEYS = "adminKeyId,issuedAt,notAfter,oarVersion,orderSha256,orgId,purposeTag,seatId,signature";

function approvalOf(v: unknown): Approval {
  const o = obj(v, "approval");
  if (Object.keys(o).sort().join(",") !== APPROVAL_KEYS) fail("malformed", "approval keys");
  if (typeof o.signature !== "string" || !/^[0-9a-f]{6746}$/.test(o.signature)) fail("malformed", "approval signature");
  try {
    canonicalOrgApproval(o as unknown as Approval);
  } catch {
    fail("malformed", "approval");
  }
  return o as unknown as Approval;
}

/** The admin's binding, self-signed with its own hybrid key (role `org-seat-admin`, subject `<org>:<seat>`). */
function adminKey(r: OrgAuthorityRecord, seatId: string, now: number): Key {
  const a = r.admins.find((x) => x.seatId === seatId)!;
  const b = obj(a.binding, "binding");
  if (b.v !== 1 || b.role !== "org-seat-admin" || b.subjectId !== `${r.orgId}:${seatId}`) fail("binding", seatId);
  if (!isUint(b.issuedAt) || (b.issuedAt as number) > now + ORG_MAX_SKEW_MS) fail("binding", seatId);
  if (typeof b.signature !== "string" || !/^[0-9a-f]{6746}$/.test(b.signature)) fail("binding", seatId);
  let pk: Uint8Array;
  try {
    pk = pqBindingPublicKey(b as never);
    const st = { role: "org-seat-admin" as const, subjectId: b.subjectId as string, ed25519PubHex: b.ed25519PubHex as string, mldsaPubHex: b.mldsaPubHex as string, issuedAt: b.issuedAt as number };
    hybridVerify(pk, TAG_PQ_KEY_BINDING, canonicalPqKeyBinding(st), Uint8Array.from(Buffer.from(b.signature as string, "hex")));
  } catch {
    return fail("binding", seatId);
  }
  return { pk, keyId: Buffer.from(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk)).toString("hex") };
}

/** Checks approvals of `order` under version `oar`; returns the signer seat ids. */
function approvals(list: unknown, orgId: string, oar: number, order: Uint8Array, now: number, keyOf: (seat: string) => Key | undefined): string[] {
  if (!Array.isArray(list)) fail("malformed", "approvals");
  const purpose = messagePurpose(order);
  const digest = orgSha256Hex(order);
  const seen: string[] = [];
  for (const raw of list as unknown[]) {
    const a = approvalOf(raw);
    if (a.orgId !== orgId) fail("wrong-org");
    if (a.oarVersion !== oar) fail("stale-oar");
    if (a.purposeTag !== purpose || a.orderSha256 !== digest) fail("order-mismatch");
    if (a.issuedAt > now + ORG_MAX_SKEW_MS) fail("future");
    if (a.notAfter < a.issuedAt || a.notAfter - a.issuedAt > ORG_APPROVAL_MAX_LIFETIME_MS) fail("malformed", "notAfter");
    if (seen.includes(a.seatId)) fail("duplicate-signer");
    seen.push(a.seatId);
    const k = keyOf(a.seatId);
    if (!k || k.keyId !== a.adminKeyId) fail("unknown-signer", a.seatId);
    try {
      hybridVerify(k!.pk, TAG_ORG_APPROVAL, canonicalOrgApproval(a), Uint8Array.from(Buffer.from(a.signature, "hex")));
    } catch {
      fail("bad-signature", a.seatId);
    }
  }
  return seen;
}

function recordOf(v: unknown): OrgAuthorityRecord {
  const r = obj(v, "record") as unknown as OrgAuthorityRecord;
  try {
    checkOrgAuthorityShape(r);
  } catch {
    fail("malformed", "record");
  }
  return r;
}

/** Replays the chain under keyd's rule; returns the records by version. */
export function verifyOrgChainForKeyd(chain: unknown, pin: OrgCgkPin, now: number): OrgAuthorityRecord[] {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > 4096) fail("malformed", "chain");
  const records: OrgAuthorityRecord[] = [];
  const keys = new Map<string, Key>();
  for (const raw of chain as unknown[]) {
    const e = obj(raw, "entry");
    const r = recordOf(e.record);
    if (r.issuedAt > now + ORG_MAX_SKEW_MS) fail("future");
    const order = canonicalOrgAuthority(r);
    const mine = new Map(r.admins.map((a) => [a.seatId, adminKey(r, a.seatId, now)]));
    const p = records[records.length - 1];
    if (!p) {
      if (e.via !== "genesis" || r.version !== 0 || r.prevHash !== ORG_GENESIS_PREV) fail("genesis");
      if (r.orgId !== pin.orgId) fail("wrong-org");
      if (orgAuthorityHash(r) !== pin.genesisHash) fail("genesis");
      const signers = approvals(e.approvals, r.orgId, 0, order, now, (s) => mine.get(s));
      for (const a of r.admins) if (!signers.includes(a.seatId)) fail("consent-missing", a.seatId);
    } else {
      if (e.via !== "direct") fail("not-direct", String(e.via));
      if (r.orgId !== p.orgId) fail("wrong-org");
      if (r.version !== p.version + 1 || r.prevHash !== orgAuthorityHash(p) || r.issuedAt <= p.issuedAt) fail("chain");
      const removed = p.admins.filter((a) => !r.admins.some((x) => x.seatId === a.seatId)).map((a) => a.seatId);
      const newcomers = r.admins
        .filter((a) => {
          const old = p.admins.find((x) => x.seatId === a.seatId);
          return !old || old.binding.ed25519PubHex !== a.binding.ed25519PubHex || old.binding.mldsaPubHex !== a.binding.mldsaPubHex;
        })
        .map((a) => a.seatId);
      if (!Array.isArray(e.approvals)) fail("malformed", "approvals");
      const all = e.approvals as unknown[];
      const isConsent = (x: unknown) => {
        const o = x as Record<string, unknown>;
        return typeof o === "object" && o !== null && newcomers.includes(o.seatId as string) && o.oarVersion === r.version;
      };
      const consenting = approvals(all.filter(isConsent), r.orgId, r.version, order, now, (s) => mine.get(s));
      for (const n of newcomers) if (!consenting.includes(n)) fail("consent-missing", n);
      const ordinary = all.filter((x) => !isConsent(x));
      const founderMoved = p.founderSeatId !== r.founderSeatId;
      if (founderMoved && !newcomers.includes(r.founderSeatId) && !ordinary.some((x) => (x as Record<string, unknown>)?.seatId === r.founderSeatId)) {
        fail("consent-missing", "new founder");
      }
      const signers = approvals(ordinary, r.orgId, p.version, order, now, (s) => keys.get(`${p.version}:${s}`));
      for (const s of signers) {
        if (p.admins.find((a) => a.seatId === s)?.kind !== "admin") fail("not-an-admin", s);
        if (removed.includes(s)) fail("removed-signer", s);
      }
      const bylawsChanged = orgSha256Hex(canonicalOrgBylaws(p.bylaws)) !== orgSha256Hex(canonicalOrgBylaws(r.bylaws));
      const k = bylawsChanged || founderMoved ? orgBylawsThreshold(p) : p.kGov;
      if (signers.length < k) fail("threshold", `${signers.length} of ${k}`);
    }
    records.push(r);
    for (const [s, k] of mine) keys.set(`${r.version}:${s}`, k);
  }
  // The head keyd verified before must still be in this chain, unchanged (05c review F4).
  if (pin.oarVersion !== undefined) {
    const held = records[pin.oarVersion];
    if (!held) fail("stale-chain", `the chain ends below v${pin.oarVersion}`);
    if (orgAuthorityHash(held!) !== pin.oarHash) fail("stale-chain", `the chain forks at v${pin.oarVersion}`);
  }
  return records;
}

const RING_KEYS = "issuedAt,keyCommitment,kind,oarVersion,orgId,prevSha256,recipientsHash,retired,scope,version";

/**
 * The whole check: returns the 32-byte CGK to adopt and its version, or throws `OrgCgkError`.
 * `args` is `{ chain, ring, recipients, approvals, key }` as the daemon sends it.
 */
export function verifyOrgCgkAdoption(
  args: Record<string, unknown>,
  pin: OrgCgkPin,
  now: number,
): { key: Uint8Array; version: number; oarVersion: number; oarHash: string; ringSha256: string } {
  const records = verifyOrgChainForKeyd(args.chain, pin, now);
  const ringObj = obj(args.ring, "ring");
  if (Object.keys(ringObj).sort().join(",") !== RING_KEYS) fail("malformed", "ring keys");
  const ring = ringObj as unknown as OrgKeyRing;
  let order: Uint8Array;
  try {
    order = canonicalOrgKeyRing(ring);
  } catch {
    return fail("malformed", "ring");
  }
  if (ring.orgId !== pin.orgId) fail("wrong-org");
  if (ring.kind !== "cgk") fail("not-cgk");
  if (ring.version <= pin.cgkVersion) fail("stale", `v${ring.version} is not above v${pin.cgkVersion}`);
  if (ring.issuedAt > now + ORG_MAX_SKEW_MS) fail("future");
  if (pin.cgkRingSha256 !== undefined && ring.version === pin.cgkVersion + 1 && ring.prevSha256 !== pin.cgkRingSha256) fail("prev-hash");
  if (!Array.isArray(args.recipients)) fail("malformed", "recipients");
  const recipients = (args.recipients as unknown[]).map((x) => {
    const o = obj(x, "recipient");
    if (Object.keys(o).sort().join(",") !== "kemKeyId,recipient,sealedHex") fail("malformed", "recipient keys");
    return o as unknown as OrgKeyRecipient;
  });
  let hash: string;
  try {
    hash = orgKeyRecipientsHash(recipients);
  } catch {
    return fail("malformed", "recipients");
  }
  if (hash !== ring.recipientsHash) fail("recipients");
  if (!recipients.some((x) => x.recipient === `box:${pin.serverDomain}`)) fail("not-recipient");
  const at = records.find((r) => r.version === ring.oarVersion);
  if (!at) fail("stale-oar");
  const keyOf = (s: string): Key | undefined => (at!.admins.some((a) => a.seatId === s) ? adminKey(at!, s, now) : undefined);
  const signers = approvals(args.approvals, ring.orgId, ring.oarVersion, order, now, keyOf);
  if (signers.length === 0) fail("threshold", "no approvals");
  for (const s of signers) if (at!.admins.find((a) => a.seatId === s)?.kind !== "admin") fail("not-an-admin", s);
  // Under the newest record shown: each signer is still an org admin there with the same keys, and an approval
  // under an older record was made before the record after it (05c review F4).
  const head = records[records.length - 1]!;
  for (const s of signers) {
    const then = at!.admins.find((a) => a.seatId === s)!;
    const nowAdmin = head.admins.find((a) => a.seatId === s);
    if (nowAdmin?.kind !== "admin" || nowAdmin.binding.ed25519PubHex !== then.binding.ed25519PubHex || nowAdmin.binding.mldsaPubHex !== then.binding.mldsaPubHex) {
      fail("stale-oar", `${s} is not an org admin of v${head.version}`);
    }
  }
  if (at!.version !== head.version) {
    const next = records[at!.version + 1]!;
    for (const raw of args.approvals as unknown[]) if ((raw as { issuedAt: number }).issuedAt >= next.issuedAt) fail("stale-oar", `approved under v${at!.version} after v${next.version}`);
  }
  if (typeof args.key !== "string" || !HEX32.test(args.key)) fail("malformed", "key");
  const key = Uint8Array.from(Buffer.from(args.key as string, "hex"));
  if (orgKeyCommitment(ring.orgId, "cgk", "*", ring.version, key) !== ring.keyCommitment) {
    key.fill(0);
    fail("commitment");
  }
  void TAG_ORG_KEY_RING;
  return { key, version: ring.version, oarVersion: head.version, oarHash: orgAuthorityHash(head), ringSha256: orgSha256Hex(order) };
}

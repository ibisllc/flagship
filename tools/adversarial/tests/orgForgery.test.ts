/**
 * Forgery against the org server, key-ring and audit-export envelopes (docs/enterprise-accounts.md
 * "Org servers", §5.4, §8, §11). Each case takes a valid object from test-vectors/org-servers and
 * changes one thing an attacker controls (a field after approval, the signer, a spliced recipient),
 * then checks the verifier refuses it.
 *
 *   AT-ENV-40  org-server-code/v2: domain splice, another org's genesis, outsider, scoped seat
 *   AT-ENV-41  org-server-register/v1: another STK, domain swap, code-hash swap, bit flip
 *   AT-ENV-42  org-seat-kem/v1 and org-box-kem/v1: moved to another seat, KEM key swapped, another STK
 *   AT-ENV-43  org-key-ring/v1: recipient spliced after approval, retired seat dropped, commitment and scope swap
 *   AT-ENV-44  org-audit-export/v1: log head swap, record hash swap, outsider
 *   AT-ENV-45  org-install-blob/v1: installer commit, registration URL or genesis changed after approval; the code's approval reused
 *   AT-ENV-46  org-box-log-head/v1: another STK, moved to another server or org, seq or head hash changed, separator refused
 *   AT-ENV-47  org-directory-entry/v1: ciphertext or header changed, an entry moved to another id or key version,
 *              a write approval reused for other bytes, a separator in any field, a replayed older entry
 *   AT-ENV-48  org-connector/v1: scopes, box or key changed after approval, a box outside the org, a retired id reused
 *   AT-ENV-50  org-directory-slice/v1: approved by a non-admin, moved to another seat, payload or tag changed,
 *              a connector whose approver left past its 7-day grace refused on the box
 *   AT-ENV-49  org-proposal/v1: signed by another key, subject or kind moved, a sealed copy dropped or swapped,
 *              roles changed, a scope the connector lacks, a paused connector; the decision form
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../../../packages/protocol/src/index.js";

const VECTORS = join(import.meta.dirname, "../../../packages/protocol/test-vectors");
const A = JSON.parse(readFileSync(join(VECTORS, "org-authority/vectors.json"), "utf8"));
const V = JSON.parse(readFileSync(join(VECTORS, "org-servers/vectors.json"), "utf8"));
const D = JSON.parse(readFileSync(join(VECTORS, "org-directory/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return A.keys[o.$key].binding;
  if (typeof o.$approval === "number") return A.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};
const entries = refs(A.chains[0]).entries.slice(0, 2);
const grants = refs(A.seatBooks[0]).grants;
const clone = <T>(x: T): T => structuredClone(x);
const flip = (h: string) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");

function ctx(now: number, revokes: unknown[] = []) {
  const state = P.verifyOrgAuthorityChain(entries, { genesisHash: A.genesisHash, now });
  const book = P.buildOrgSeatBook(state, { grants, revokes: revokes as never, now });
  const keys: P.OrgKemKey[] = [];
  for (const k of V.kems.seat) {
    try {
      keys.push(P.verifyOrgSeatKem(state, book, k, now));
    } catch {
      /* departed */
    }
  }
  for (const k of V.kems.box) keys.push(P.verifyOrgBoxKem(k, A.orgId, V.register.request.serverIdentityPubKeyHex, now));
  return { state, book, kems: P.newestOrgKems(keys), servers: new Set<string>(V.servers), now };
}

describe("AT-ENV-40 org-server-code/v2", () => {
  const good = V.serverCodes[0];
  const run = (code: P.OrgServerCode, approvals = good.approvals) => {
    const c = ctx(good.now);
    return () => P.verifyOrgServerCode(c.state, c.book, code, approvals, good.now);
  };
  it("AT-ENV-40a the valid code verifies (control)", () => expect(run(good.code)).not.toThrow());
  it("AT-ENV-40b a domain changed after approval is refused (catches: one approval reused for another server)", () => {
    expect(run({ ...good.code, serverDomain: "evil.acme.flagship.services", serverName: "evil" })).toThrow(P.OrgAuthorityError);
  });
  it("AT-ENV-40c another org's genesis is refused (catches: a box pinned to an attacker's org)", () => {
    expect(run({ ...good.code, genesisHash: "ee".repeat(32) })).toThrow(/wrong-org/);
  });
  it("AT-ENV-40d an outsider's approval and a scoped seat without servers-add are refused", () => {
    for (const c of V.serverCodes.slice(1, 3)) {
      const k = ctx(c.now);
      expect(() => P.verifyOrgServerCode(k.state, k.book, c.code, c.approvals, c.now)).toThrow(P.OrgAuthorityError);
    }
  });
  it("AT-ENV-40e a delegated key swapped after approval is refused", () => {
    expect(run({ ...good.code, delegatedPubKeyHex: "aa".repeat(32) })).toThrow(/order-mismatch/);
  });
});

describe("AT-ENV-41 org-server-register/v1", () => {
  const r = V.register.request;
  it("AT-ENV-41a the valid registration verifies (control)", () => expect(P.verifyOrgServerRegister(r, V.register.signature)).toBe(true));
  it("AT-ENV-41b another STK, another domain, another code hash, a flipped bit: each refused", () => {
    expect(P.verifyOrgServerRegister({ ...r, serverIdentityPubKeyHex: "11".repeat(32) }, V.register.signature)).toBe(false);
    expect(P.verifyOrgServerRegister({ ...r, serverDomain: "other.acme.flagship.services" }, V.register.signature)).toBe(false);
    expect(P.verifyOrgServerRegister({ ...r, codeSha256: "00".repeat(32) }, V.register.signature)).toBe(false);
    expect(P.verifyOrgServerRegister(r, flip(V.register.signature))).toBe(false);
  });
});

describe("AT-ENV-42 org-seat-kem/v1 and org-box-kem/v1", () => {
  const now = V.keyRings[0].now;
  it("AT-ENV-42a a seat's statement moved to another seat is refused (catches: sealing a key to an attacker's KEM key under a colleague's name)", () => {
    const c = ctx(now);
    const moved = clone(V.kems.seat[3]);
    moved.statement.seatId = V.kems.seat[0].statement.seatId;
    expect(() => P.verifyOrgSeatKem(c.state, c.book, moved, now)).toThrow(P.OrgAuthorityError);
  });
  it("AT-ENV-42b a KEM key swapped under a valid signature is refused", () => {
    const c = ctx(now);
    const swapped = { ...V.kems.seat[0], kemPubHex: V.kems.seat[1].kemPubHex };
    expect(() => P.verifyOrgSeatKem(c.state, c.book, swapped, now)).toThrow(/binding/);
    const boxSwapped = { ...V.kems.box[0], kemPubHex: V.kems.seat[1].kemPubHex };
    expect(() => P.verifyOrgBoxKem(boxSwapped, A.orgId, V.register.request.serverIdentityPubKeyHex, now)).toThrow(/binding/);
  });
  it("AT-ENV-42c a box statement under another STK, and a departed seat's statement, are refused", () => {
    expect(() => P.verifyOrgBoxKem(V.kems.box[0], A.orgId, "22".repeat(32), now)).toThrow(/bad-signature/);
    const c = ctx(V.rotations[0].now, [V.revokeS]);
    expect(() => P.verifyOrgSeatKem(c.state, c.book, V.kems.seat[2], V.rotations[0].now)).toThrow(/seat-unknown/);
  });
});

describe("AT-ENV-43 org-key-ring/v1", () => {
  const good = V.keyRings[3];
  const check = (b: P.OrgKeyRingBundle, prev = good.prev, fresh = true) => {
    const c = ctx(good.now, good.revokes);
    return () => P.verifyOrgKeyRing(c, b, prev, { fresh });
  };
  it("AT-ENV-43a the rotation after S left verifies (control)", () => expect(check(good.bundle)).not.toThrow());
  it("AT-ENV-43b a recipient spliced in after approval is refused, fresh or stored (catches: .com adding a copy for itself)", () => {
    const spliced = clone(good.bundle);
    spliced.recipients.push({ ...V.opens[2].ring.recipients.find((x: { recipient: string }) => x.recipient.startsWith("seat:51")) });
    expect(check(spliced)).toThrow(P.OrgAuthorityError);
    expect(check(spliced, good.prev, false)).toThrow(P.OrgAuthorityError);
  });
  it("AT-ENV-43c dropping the retired seat, swapping the commitment or the scope after approval is refused", () => {
    for (const mut of [
      (r: P.OrgKeyRing) => (r.retired = []),
      (r: P.OrgKeyRing) => (r.keyCommitment = "00".repeat(32)),
      (r: P.OrgKeyRing) => (r.scope = "other.acme.flagship.services"),
    ]) {
      const b = clone(good.bundle);
      mut(b.ring);
      expect(check(b, good.prev, false)).toThrow(P.OrgAuthorityError);
    }
  });
  it("AT-ENV-43d an outsider's approval is refused", () => {
    const b = clone(good.bundle);
    const x = A.keys["X outsider"];
    b.approvals = [
      P.signOrgApproval(
        { orgId: A.orgId, oarVersion: 1, order: P.canonicalOrgKeyRing(b.ring), seatId: x.seatId, adminKeyId: x.keyId, issuedAt: b.ring.issuedAt, notAfter: b.ring.issuedAt + 3_600_000 },
        Uint8Array.from(Buffer.from(x.edSeedHex + x.mldsaSeedHex, "hex")),
      ),
    ];
    expect(check(b, good.prev, false)).toThrow(/unknown-signer/);
  });
});

describe("AT-ENV-44 org-audit-export/v1", () => {
  const now = V.audit.cases[0].now;
  it("AT-ENV-44a the export verifies (control)", () => {
    expect(P.verifyOrgAuditExport(clone(V.audit.export), { genesisHash: A.genesisHash, now }).signedBy).toBe(A.keys["A founder"].seatId);
  });
  it("AT-ENV-44b a log head or record hash swapped in the signed statement is refused (catches: a truncated log passed off as complete)", () => {
    const head = clone(V.audit.export);
    head.statement.logSeq -= 1;
    head.statement.logHeadHash = head.log[head.log.length - 2].entryHash;
    head.log.pop();
    expect(() => P.verifyOrgAuditExport(head, { genesisHash: A.genesisHash, now })).toThrow(/order-mismatch/);
    const rec = clone(V.audit.export);
    rec.statement.oarHash = "00".repeat(32);
    expect(() => P.verifyOrgAuditExport(rec, { genesisHash: A.genesisHash, now })).toThrow(/order-mismatch/);
  });
  it("AT-ENV-44c an export under another genesis is refused", () => {
    expect(() => P.verifyOrgAuditExport(clone(V.audit.export), { genesisHash: "11".repeat(32), now })).toThrow(/wrong-org/);
  });
});

describe("AT-ENV-45 org-install-blob/v1", () => {
  const good = V.installBlobs[0];
  const run = (b: P.OrgInstallBlob) => {
    const c = ctx(good.now);
    return () => P.verifyOrgInstallBlob(c.state, c.book, b, good.now);
  };
  it("AT-ENV-45a the recipe verifies (control)", () => expect(run(good.blob)).not.toThrow());
  it("AT-ENV-45b the installer commit or the registration URL changed after approval is refused (catches: a recipe pointed at other code or another .com)", () => {
    expect(run({ ...good.blob, installerGitRef: "c1".repeat(20) })).toThrow(/order-mismatch/);
    const otherUrl = good.blob.registrationUrl.replace("flagshipserver.com", "evil.example");
    expect(run({ ...good.blob, registrationUrl: otherUrl })).toThrow(/order-mismatch/);
  });
  it("AT-ENV-45c the server code's approval cannot stand in for the recipe's", () => {
    expect(run({ ...good.blob, approvals: good.blob.codeApprovals })).toThrow(/order-mismatch/);
  });
  it("AT-ENV-45d unlock mode or disk encryption downgraded after approval is refused", () => {
    expect(run({ ...good.blob, bootUnlockMode: "auto" })).toThrow(/order-mismatch/);
    expect(run({ ...good.blob, diskEncryption: "none" })).toThrow(/order-mismatch/);
  });
});

describe("AT-ENV-46 org-box-log-head/v1 (a box's own signed log head)", () => {
  const good = V.audit.export.boxLogHeads[0];
  const stk = V.register.request.serverIdentityPubKeyHex;
  it("AT-ENV-46a the head verifies under the key the server registered with (control)", () => {
    expect(() => P.verifyOrgBoxLogHead(clone(good), stk)).not.toThrow();
  });
  it("AT-ENV-46b another box's key does not verify it (catches: one box vouching for another's log)", () => {
    const other = Buffer.from(P.ed.getPublicKey(new Uint8Array(32).fill(0x77))).toString("hex");
    expect(() => P.verifyOrgBoxLogHead(clone(good), other)).toThrow(/bad-signature/);
  });
  it("AT-ENV-46c moving the head to another server or org breaks it", () => {
    for (const patch of [{ serverDomain: "other.acme.flagship.services" }, { orgId: "ab".repeat(16) }]) {
      const b = clone(good);
      Object.assign(b.head, patch);
      expect(() => P.verifyOrgBoxLogHead(b, stk)).toThrow(/bad-signature/);
    }
  });
  it("AT-ENV-46d a rewritten log (another seq or head hash) does not verify", () => {
    const a = clone(good);
    a.head.seq += 1;
    expect(() => P.verifyOrgBoxLogHead(a, stk)).toThrow(/bad-signature/);
    const b = clone(good);
    b.head.headHash = flip(b.head.headHash);
    expect(() => P.verifyOrgBoxLogHead(b, stk)).toThrow(/bad-signature/);
    const c = clone(good);
    c.signature = flip(c.signature);
    expect(() => P.verifyOrgBoxLogHead(c, stk)).toThrow(/bad-signature/);
  });
  it("AT-ENV-46e no field can carry the separator", () => {
    const b = clone(good);
    b.head.serverDomain = `${good.head.serverDomain}|1`;
    expect(() => P.canonicalOrgBoxLogHead(b.head)).toThrow(/malformed/);
    expect(() => P.orgBoxLogEntryHash(1, "00".repeat(32), "aa|bb")).toThrow(/malformed/);
  });
});

describe("AT-ENV-47 org-directory-entry/v1 (sealed names under the directory key)", () => {
  const good = D.entries[0];
  const key = Uint8Array.from(Buffer.from(good.directoryKeyHex, "hex"));
  const open = (s: P.OrgDirectorySealed) => () => P.openOrgDirectoryEntry(s, key);
  it("AT-ENV-47a the sealed entry opens (control)", () => expect(open(clone(good.sealed))()).toEqual(good.entry));
  it("AT-ENV-47b a changed ciphertext, nonce or tag is refused", () => {
    for (const i of [0, 30, good.sealed.sealedHex.length - 1]) {
      const s = clone(good.sealed);
      s.sealedHex = s.sealedHex.slice(0, i) + (s.sealedHex[i] === "0" ? "1" : "0") + s.sealedHex.slice(i + 1);
      expect(open(s)).toThrow(/malformed/);
    }
  });
  it("AT-ENV-47c moving an entry to another id, org, key version or bucket is refused (catches: .com renaming a seat by swapping entries)", () => {
    for (const patch of [{ entryId: D.entries[1].entryId }, { orgId: "ab".repeat(16) }, { keyVersion: 2 }, { sizeBucket: 512 }]) {
      expect(open({ ...clone(good.sealed), ...patch })).toThrow(/malformed/);
    }
  });
  it("AT-ENV-47d an approval of one write does not cover other bytes", () => {
    const w1 = P.canonicalOrgDirectoryWrite(good.sealed);
    const w2 = P.canonicalOrgDirectoryWrite(D.entries[1].sealed);
    const w3 = P.canonicalOrgDirectoryWrite({ ...good.sealed, issuedAt: good.sealed.issuedAt + 1 });
    expect(new Set([w1, w2, w3].map((b) => Buffer.from(b).toString("hex"))).size).toBe(3);
  });
  it("AT-ENV-47e no field can carry the separator: text travels encoded, ids and source are strict", () => {
    const body = new TextDecoder().decode(P.canonicalOrgDirectoryEntryBody({ ...good.entry, pseudonym: "a|b|c", groups: ["x|y"] }));
    expect(body.split("|")).toHaveLength(11);
    expect(() => P.canonicalOrgDirectoryEntryBody({ ...good.entry, source: "manual|scim" })).toThrow(/malformed/);
    expect(() => P.canonicalOrgDirectoryWrite({ ...good.sealed, entryId: `${good.sealed.entryId}|` })).toThrow(/malformed/);
    for (const c of D.badBodies) expect(() => P.parseOrgDirectoryEntryBody(new TextEncoder().encode(c.body))).toThrow();
  });
  it("AT-ENV-47f a replayed older entry for the same seat does not win", () => {
    const keys = new Map([[1, key]]);
    const view = P.openOrgDirectory(D.orgId, [...D.newest.sealed].reverse(), keys);
    expect(view.bySeat.get(D.newest.expect.seat)?.pseudonym).toBe(D.newest.expect.pseudonym);
  });
});

describe("AT-ENV-48 org-connector/v1 (a directory connector's authority record)", () => {
  const C = D.connectors;
  const c = () => {
    const state = P.verifyOrgAuthorityChain(entries, { genesisHash: A.genesisHash, now: C.now });
    return { state, book: P.buildOrgSeatBook(state, { grants, revokes: [], now: C.now }), servers: new Set(["home.acme.flagship.services"]), now: C.now };
  };
  it("AT-ENV-48a the approved record verifies (control)", () => expect(() => P.verifyOrgConnector(c(), clone(C.connector), null)).not.toThrow());
  it("AT-ENV-48b widening scopes, moving it to another box or swapping its key after approval is refused", () => {
    for (const patch of [{ scopes: ["propose-invite", "propose-offboard", "update-entry"].slice(0, 1) }, { serverDomain: "other.acme.flagship.services" }, { mappingSha256: "00".repeat(32) }]) {
      const b = clone(C.connector);
      Object.assign(b.connector, patch);
      expect(() => P.verifyOrgConnector({ ...c(), servers: new Set(["home.acme.flagship.services", "other.acme.flagship.services"]) }, b, null)).toThrow(P.OrgAuthorityError);
    }
    const k = clone(C.connector);
    k.connectorPubHex = Buffer.from(P.hybridSigKeygen(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).publicKey).toString("hex");
    expect(() => P.verifyOrgConnector(c(), k, null)).toThrow(/binding/);
  });
  it("AT-ENV-48c a retired connector id never comes back", () => {
    const retired = { ...clone(C.connector).connector, status: "retired", issuedAt: C.connector.connector.issuedAt - 1 };
    expect(() => P.verifyOrgConnector(c(), clone(C.connector), retired)).toThrow(/seat-revoked/);
  });
  it("AT-ENV-48d no field can carry the separator", () => {
    expect(() => P.canonicalOrgConnector({ ...clone(C.connector).connector, serverDomain: "home|x" })).toThrow(/malformed/);
    expect(() => P.canonicalOrgConnector({ ...clone(C.connector).connector, kind: "scim|ldap" })).toThrow(/malformed/);
  });
});

describe("AT-ENV-49 org-proposal/v1 (a connector proposes; admins decide)", () => {
  const C = D.connectors;
  const [inv, off] = C.proposals;
  const run = (b: unknown, rolesHash = off.rolesHash, conn = C.connector) => () => P.verifyOrgProposal(conn, b as never, { rolesHash, now: C.now });
  it("AT-ENV-49a both proposals verify (control)", () => {
    expect(run(clone(inv.bundle), inv.rolesHash)).not.toThrow();
    expect(run(clone(off.bundle))).not.toThrow();
  });
  it("AT-ENV-49b moving it to another subject, kind or proposal id breaks the connector's signature", () => {
    for (const patch of [{ subject: "ee".repeat(16) }, { proposalId: "ee".repeat(16) }, { issuedAt: off.bundle.proposal.issuedAt + 1 }]) {
      const b = clone(off.bundle);
      Object.assign(b.proposal, patch);
      expect(run(b)).toThrow(/bad-signature/);
    }
    const k = clone(off.bundle);
    k.proposal.kind = "entry-update";
    expect(run(k)).toThrow(/bad-signature/);
  });
  it("AT-ENV-49c a sealed copy dropped, added or swapped is refused (catches: .com hiding a proposal from one admin)", () => {
    const a = clone(off.bundle);
    a.recipients = a.recipients.slice(1);
    expect(run(a)).toThrow(/order-mismatch/);
    const b = clone(off.bundle);
    b.recipients[0].sealedHex = inv.bundle.recipients[0].sealedHex;
    expect(run(b)).toThrow(/order-mismatch/);
  });
  it("AT-ENV-49d roles changed beside the statement, a scope the connector lacks, a paused connector: refused", () => {
    expect(run(clone(inv.bundle), "ab".repeat(32))).toThrow(/order-mismatch/);
    const narrow = clone(C.connector);
    narrow.connector.scopes = ["update-entry"];
    expect(run(clone(off.bundle), "", narrow)).toThrow(/scope/);
    const paused = clone(C.connector);
    paused.connector.status = "paused";
    expect(run(clone(off.bundle), "", paused)).toThrow(/seat-revoked/);
  });
  it("AT-ENV-49e another key's signature is refused; the decision form is strict", () => {
    const other = clone(C.connector);
    other.connectorPubHex = Buffer.from(P.hybridSigKeygen(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).publicKey).toString("hex");
    expect(run(clone(off.bundle), "", other)).toThrow(/bad-signature/);
    expect(() => P.canonicalOrgProposalDecision({ ...C.decision.statement, refSha256: "00".repeat(32) })).toThrow(/malformed/);
    expect(() => P.canonicalOrgProposalDecision({ ...C.decision.statement, decision: "done|x" })).toThrow(/malformed/);
  });
});

describe("AT-ENV-50 org-directory-slice/v1 (a member's sealed slice) and connector re-approval", () => {
  const S = D.slices;
  const slice = S.seats[0];
  const state = P.verifyOrgAuthorityChain(entries, { genesisHash: A.genesisHash, now: S.now });
  const book = P.buildOrgSeatBook(state, { grants, revokes: [], now: S.now });
  const key = (name: string) => {
    const k = A.keys[name];
    return { seatId: k.seatId as string, keyId: k.keyId as string, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
  };
  const approve = (k: ReturnType<typeof key>, s: P.OrgDirectorySlice) =>
    P.signOrgApproval({ orgId: A.orgId, oarVersion: 1, order: P.canonicalOrgDirectorySliceWrite(s), seatId: k.seatId, adminKeyId: k.keyId, issuedAt: s.issuedAt, notAfter: s.issuedAt + 86_400_000 }, k.secret);
  it("AT-ENV-50a an org admin's approval verifies (control); a scoped seat's or another slice's does not", () => {
    expect(() => P.verifyOrgDirectorySliceApproval(state, book, slice.slice, [approve(key("B admin"), slice.slice)], S.now)).not.toThrow();
    expect(() => P.verifyOrgDirectorySliceApproval(state, book, slice.slice, [approve(key("S scoped admin"), slice.slice)], S.now)).toThrow(P.OrgAuthorityError);
    expect(() => P.verifyOrgDirectorySliceApproval(state, book, slice.slice, [approve(key("B admin"), S.seats[1].slice)], S.now)).toThrow(P.OrgAuthorityError);
  });
  it("AT-ENV-50b moved to another seat, or with the tag or ciphertext changed, it does not open or verify", () => {
    const kp = P.orgKemKeyPair(Buffer.from(slice.kemSeedHex, "hex"));
    expect(() => P.openOrgDirectorySlice({ ...slice.slice, seatId: S.seats[1].seatId }, kp.kemSecret)).toThrow(/malformed/);
    expect(() => P.verifyOrgDirectorySliceApproval(state, book, { ...slice.slice, contentTag: "00".repeat(32) }, [approve(key("B admin"), slice.slice)], S.now)).toThrow();
    expect(() => P.openOrgDirectorySlice({ ...slice.slice, sealedHex: flip(slice.slice.sealedHex) }, kp.kemSecret)).toThrow(/malformed/);
  });
  it("AT-ENV-50c a payload with a separator in a server or out of order is refused", () => {
    expect(() => P.canonicalOrgDirectorySlicePayload(A.orgId, slice.seatId, { entries: [], servers: ["a|b"] })).toThrow(/malformed/);
    expect(() => P.canonicalOrgDirectorySlicePayload(A.orgId, slice.seatId, { entries: [], servers: ["b.x", "a.x"] })).toThrow(/malformed/);
  });
  it("AT-ENV-50d a connector whose last approver left more than 7 days ago is suspended on the box (stored mode)", () => {
    const all = refs(A.chains[0]).entries;
    const c = D.standing.cases[2];
    const st = P.verifyOrgAuthorityChain(all.slice(0, c.entries), { genesisHash: A.genesisHash, now: c.now });
    const bk = P.buildOrgSeatBook(st, { grants, revokes: [], now: c.now });
    expect(() => P.verifyOrgConnector({ state: st, book: bk, servers: new Set(["home.acme.flagship.services"]), now: c.now }, clone(c.bundle), null, { stored: true })).toThrow(/suspended/);
  });
});

/**
 * The relay mesh records and rules (relayMesh.ts) against the shared vectors in test-vectors/relay-mesh, which the
 * Rust twin (flagship-crypto relay_mesh.rs) also replays, plus the properties the vectors cannot show.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";
import type { MeshCheckContext, RelayDirectory, RelayLogState, SignedRelayLogEntry } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const v: Any = JSON.parse(readFileSync(new URL("../test-vectors/relay-mesh/vectors.json", import.meta.url), "utf8"));
const td = new TextDecoder();
const APEX: string = v.servicesApex;
const T0: number = v.t0;
const CA: string[] = v.caKeys;
const D: RelayDirectory = v.directory.directory;
const ENTRIES: SignedRelayLogEntry[] = v.log.entries.map((e: Any) => ({ entry: e.entry, signature: e.signature }));
const seedOf = (name: string) => Uint8Array.from(Buffer.from(v.keys[name].seed, "hex"));
const signer = (name: string) => (m: Uint8Array) => P.ed.sign(m, seedOf(name));

const applied = P.applyRelayLog(P.emptyRelayLogState(APEX), ENTRIES, v.logKey);
if (!applied.ok) throw new Error("the vector log must apply");
const LOG = applied.state;
const ctx = (now: number = T0): MeshCheckContext => ({ servicesApex: APEX, log: LOG, directory: D, now });
const summary = (s: RelayLogState) => ({
  sequence: s.sequence,
  tipSha256: s.tipSha256,
  boxesByName: Object.fromEntries([...s.boxesByName].sort()),
  boxNames: Object.fromEntries([...s.boxNames].sort()),
  revokedBoxes: Object.fromEntries([...s.revokedBoxes].sort()),
  authorities: Object.fromEntries([...s.authorities].sort()),
  policyHeads: Object.fromEntries([...s.policyHeads].sort()),
  revokedRenewalKeys: [...s.revokedRenewalKeys].sort(),
  revokedGrants: Object.fromEntries([...s.revokedGrants].sort()),
  revokedCerts: [...s.revokedCerts].sort(),
  revokedRelays: Object.fromEntries([...s.revokedRelays].sort()),
});

describe("relay mesh vectors", () => {
  it("constants match", () => {
    for (const [k, val] of Object.entries(v.constants)) expect((P as Any)[k], k).toBe(val);
    expect(P.PHONE_ROUTE_GRANT_TTL_MS).toBe(P.PHONE_ROUTE_LEASE_MS);
  });

  it("hashes", () => {
    for (const c of v.hashes.nameHash) {
      if (c.throws) expect(() => P.nameHash(c.input), c.input).toThrow();
      else expect(P.nameHash(c.input)).toBe(c.output);
    }
    for (const c of v.hashes.accountHash) {
      if (c.throws) expect(() => P.accountHash(c.input), c.input).toThrow();
      else expect(P.accountHash(c.input)).toBe(c.output);
    }
  });

  it("records: canonical bytes, deterministic signatures, verification", () => {
    for (const r of v.records) {
      const kind = r.kind as P.RelayMeshRecordKind;
      const sig = P.signRelayMeshRecord(kind, r.record, signer(r.signer));
      expect(sig, r.kind).toBe(r.signature);
      expect(P.verifyRelayMeshRecord(kind, r.record, r.signature, v.keys[r.signer].pub)).toBe(true);
      expect(P.verifyRelayMeshRecord(kind, r.record, r.signature, v.keys.ca.pub)).toBe(false);
    }
    expect(td.decode(P.canonicalBoxAttachment(v.records[2].record))).toBe(v.records[2].canonical);
    for (const b of v.blessings) {
      expect(td.decode(P.canonicalRelayBlessing(b.blessing))).toBe(b.canonical);
      expect(P.signRelayBlessing(b.blessing, { publicKey: Buffer.from(v.keys.ca.pub, "hex"), privateKey: seedOf("ca") })).toEqual(b.blessing);
    }
    const d = v.directory;
    expect(D.relays.map((r) => P.relayDirectoryEntryLine(r, APEX))).toEqual(d.lines);
    expect(P.relayDirectoryEntriesSha256(D.relays, APEX)).toBe(d.entriesSha256);
    expect(td.decode(P.canonicalRelayDirectory(D))).toBe(d.canonical);
  });

  it("refuses every malformed record", () => {
    const fns: Record<string, (r: Any, apex?: string) => unknown> = {
      "relay-blessing": P.canonicalRelayBlessing,
      "relay-blessing-request": P.canonicalRelayBlessingRequest,
      "relay-directory": P.canonicalRelayDirectory,
      "relay-log": (r, apex) => P.canonicalRelayLogEntry(apex ?? APEX, r),
      "relay-log-head": P.canonicalRelayLogHead,
      "relay-attachment": P.canonicalBoxAttachment,
      "relay-legacy-attachment": P.canonicalLegacyAttachment,
      "relay-withdraw": P.canonicalRelayWithdraw,
      "relay-bridge-auth": P.canonicalBridgeAuth,
      "relay-move-hint": P.canonicalMoveHint,
      "relay-account-move": P.canonicalAccountMove,
      "phone-route-grant": P.canonicalPhoneRouteGrant,
    };
    for (const c of v.canonicalErrors) expect(() => fns[c.kind]!(c.record, c.apex), `${c.kind}: ${c.name}`).toThrow();
    for (const m of v.log.makeErrors) expect(() => P.makeRelayLogEntry(m.sequence, m.at, m.body)).toThrow();
  });

  it("applies the log: order, duplicates, gaps, forgeries, malformed rows", () => {
    for (const e of v.log.entries) {
      expect(td.decode(P.canonicalRelayLogEntry(APEX, e.entry))).toBe(e.canonical);
      expect(P.relayLogEntryHash(APEX, e.entry)).toBe(e.hash);
      expect(P.signRelayLogEntry(APEX, e.entry, signer("log"))).toBe(e.signature);
      expect(P.makeRelayLogEntry(e.entry.sequence, e.entry.at, P.parseRelayLogEntry(e.entry))).toEqual(e.entry);
    }
    const five = P.applyRelayLog(P.emptyRelayLogState(APEX), ENTRIES.slice(0, 5), v.logKey);
    for (const c of v.log.cases) {
      const from = c.from === 0 ? P.emptyRelayLogState(APEX) : five.state;
      const list = c.entries.map((e: Any) => (typeof e === "number" ? ENTRIES[e - 1] : e));
      const r = P.applyRelayLog(from, list, c.logKey);
      const got = r.ok ? { ok: true, applied: r.applied, state: summary(r.state) } : { ok: false, reason: r.reason, at: r.at, applied: r.applied, state: summary(r.state) };
      expect(got, c.name).toEqual(c.expected);
    }
    expect(summary(LOG)).toEqual(v.log.finalState);
    expect({ alice: P.relayLogAdminKey(LOG, "alice"), bob: P.relayLogAdminKey(LOG, "bob"), carol: P.relayLogAdminKey(LOG, "carol") }).toEqual(v.log.adminKeys);
  });

  it("heads", () => {
    for (const c of v.heads.verify) expect(P.verifyRelayLogHead(c.signed, v.logKey, c.apex), c.name).toEqual(c.expected);
    for (const c of v.heads.status) expect(P.relayLogHeadStatus(LOG, c.head), c.name).toBe(c.expected);
    const short = { ...LOG, recentTips: new Map([[LOG.sequence, LOG.tipSha256]]) };
    expect(P.relayLogHeadStatus(short, v.heads.unknownWithShortHistory.head)).toBe(v.heads.unknownWithShortHistory.expected);
    for (const c of v.heads.fresh) expect(P.relayLogFresh(LOG, c.head, c.now), c.name).toBe(c.expected);
    for (const c of v.heads.newer) expect(P.newerRelayLogHead(c.current, c.candidate), c.name).toBe(c.expected);
  });

  it("blessings, requests and the directory", () => {
    const k = v.checks;
    for (const c of k.blessing) expect(P.verifyRelayBlessing(c.blessing, c.caKeys, c.now, c.apex), c.name).toEqual(c.expected);
    for (const c of k.blessingRequest) expect(P.checkRelayBlessingRequest(c.request, c.signature, c.apex, c.now), c.name).toEqual(c.expected);
    for (const c of k.directory) expect(P.verifyRelayDirectory(c.directory, c.caKeys, c.now, c.apex), c.name).toEqual(c.expected);
    for (const c of k.newerDirectory) expect(P.newerRelayDirectory(c.current, c.candidate), c.name).toBe(c.expected);
  });

  it("attachments, withdrawals, precedence", () => {
    const k = v.checks;
    for (const c of k.boxAttachment) expect(P.checkBoxAttachment(c.attachment, c.signature, ctx(c.now), c.holder), c.name).toEqual(c.expected);
    for (const c of k.legacyAttachment) expect(P.checkLegacyAttachment(c.attachment, c.signature, ctx(c.now)), c.name).toEqual(c.expected);
    for (const c of k.compareAttachments) expect(Math.sign(P.compareAttachments(c.a, c.b)), c.name).toBe(c.expected);
    for (const c of k.withdraw) expect(P.checkWithdraw(c.withdraw, c.signature, ctx(c.now)), c.name).toEqual(c.expected);
    for (const c of k.withdrawCovers) expect(P.withdrawCovers(c.withdraw, c.item), c.name).toBe(c.expected);
  });

  it("bridges, hints, moves, phones", () => {
    const k = v.checks;
    for (const c of k.bridgeAuth) {
      const r = P.checkBridgeAuth({ auth: c.auth, role: c.role, selfRelayId: c.selfRelayId, selfNonce: c.selfNonce, heldBlessing: c.heldBlessing, caKeys: CA, ctx: ctx(c.now) });
      expect(r.ok ? { ok: true, blessingRelayId: r.blessing.relayId } : r, c.name).toEqual(c.expected);
    }
    for (const c of k.moveHint) {
      const r = P.checkMoveHint({
        hint: c.hint,
        signature: c.signature,
        target: c.target,
        box: { serverFqdn: `home.alice.${APEX}`, boxPub: v.keys.boxHome.pub, servicesApex: APEX },
        current: { relayId: "iad1", relayKey: v.keys.iad1.pub },
        directory: D,
        directoryFetchedAt: c.directoryFetchedAt,
        caKeys: CA,
        rate: c.rate,
        now: c.now,
      });
      expect(r, c.name).toEqual(c.expected);
    }
    for (const c of k.recordMoveHint) expect(P.recordMoveHint(c.rate, c.reason, c.now), c.name).toEqual(c.expected);
    for (const c of k.recordMoveTargetFailed) expect(P.recordMoveTargetFailed(c.rate, c.relayId, c.now), c.name).toEqual(c.expected);
    for (const c of k.accountMove) {
      expect(P.checkAccountMove({ move: c.move, signature: c.signature, expectedHome: c.expectedHome, lastAcceptedAt: c.lastAcceptedAt, ctx: ctx(c.now) }), c.name).toEqual(c.expected);
    }
    for (const c of k.phoneItem) expect(P.checkPhoneItem(c.item, c.announcer, ctx(c.now), c.highestLive), c.name).toEqual(c.expected);
    for (const c of k.comparePhoneItems) expect(Math.sign(P.comparePhoneItems(c.a, c.b)), c.name).toBe(c.expected);
  });

  it("routing: home, ledger ranking, rebalancing, serving at a policy head", () => {
    const k = v.checks;
    for (const c of k.accountHome) expect(P.accountHome({ attachments: c.attachments, directory: D, move: c.move, now: c.now }), c.name).toBe(c.expected);
    for (const c of k.phoneLedgerRanking) expect(P.phoneLedgerRanking(c.account, D, c.withLog ? LOG : null), c.account).toEqual(c.expected);
    for (const c of k.rebalance) {
      expect(P.rebalanceDecision({ home: c.home, window: c.window, relays: c.relays, lastMoveAt: c.lastMoveAt, hasLegacyBox: c.hasLegacyBox, now: c.now }), c.name).toEqual(c.expected);
    }
    for (const c of k.servingAtHead) {
      const { revokedBoxes, ...input } = c.input;
      const got = P.servingDecision({ ...input, revocations: { boxes: new Map(Object.entries(revokedBoxes) as Array<[string, number]>), renewalKeys: new Set() } });
      expect(got, c.name).toEqual(c.expected);
    }
  });
});

describe("relay mesh properties", () => {
  it("applyRelayLog never changes the state passed in, and keeps the valid prefix on failure", () => {
    const empty = P.emptyRelayLogState(APEX);
    const before = summary(empty);
    const r = P.applyRelayLog(empty, [ENTRIES[0]!, ENTRIES[1]!, ENTRIES[3]!], v.logKey);
    expect(summary(empty)).toEqual(before);
    expect(r).toMatchObject({ ok: false, reason: "gap", at: 3, applied: 2 });
    expect(r.state.sequence).toBe(2);
    const again = P.applyRelayLog(r.state, ENTRIES.slice(2), v.logKey);
    expect(again.ok && summary(again.state)).toEqual(summary(LOG));
    const none = P.applyRelayLog(LOG, ENTRIES.slice(0, 3), v.logKey);
    expect(none.ok && none.state).toBe(LOG);
  });

  it("forgets tips past the history window", () => {
    let s = P.emptyRelayLogState(APEX);
    const sign = signer("log");
    const list: SignedRelayLogEntry[] = [];
    for (let i = 1; i <= P.RELAY_LOG_TIP_HISTORY + 5; i++) {
      const e = P.makeRelayLogEntry(i, T0 + i, { kind: "cert-revoke", accountHash: P.accountHash("alice"), certId: i.toString(16).padStart(64, "0") });
      list.push({ entry: e, signature: P.signRelayLogEntry(APEX, e, sign) });
    }
    const r = P.applyRelayLog(s, list, v.keys.log.pub);
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.recentTips.size).toBe(P.RELAY_LOG_TIP_HISTORY);
    expect(P.relayLogHeadStatus(s, { servicesApex: APEX, sequence: 1, tipSha256: P.relayLogEntryHash(APEX, list[0]!.entry), directoryVersion: 1, issuedAt: T0 })).toBe("unknown");
    expect(P.relayLogHeadStatus(s, { servicesApex: APEX, sequence: 10, tipSha256: P.relayLogEntryHash(APEX, list[9]!.entry), directoryVersion: 1, issuedAt: T0 })).toBe("applied");
  });

  it("feeds servingDecision through the box-keyed adapter", () => {
    const rev = P.relayLogRevocations(LOG);
    expect(P.boxRevoked(rev, v.keys.boxOld.pub, 1)).toBe(true);
    expect(P.boxRevoked(rev, "someone", v.keys.boxOld.pub, 1)).toBe(true);
    expect(P.boxRevoked(rev, v.keys.boxOld.pub, 2)).toBe(false);
    expect(P.boxRevoked(rev, v.keys.boxHome.pub, 1)).toBe(false);
    expect(P.relayLogPolicyHead(LOG, v.keys.boxCabin.pub, 1)).toMatchObject({ policyGen: 2, policySha256: "22".repeat(32) });
    expect(P.relayLogBox(LOG, `HOME.alice.${APEX}`)).toMatchObject({ boxPub: v.keys.boxHome.pub, regGen: 1 });
    expect(P.relayLogBox(LOG, `lab.alice.${APEX}`)).toMatchObject({ boxPub: v.keys.boxLab2.pub, regGen: 2 });
    expect(LOG.boxNames.has(v.keys.boxLab.pub)).toBe(false);
  });

  it("a box that changes name drops its old name", () => {
    const e1 = P.makeRelayLogEntry(1, T0, { kind: "box-register", nameHash: P.nameHash(`a.alice.${APEX}`), boxPub: v.keys.boxHome.pub, regGen: 1 });
    const e2 = P.makeRelayLogEntry(2, T0, { kind: "box-register", nameHash: P.nameHash(`b.alice.${APEX}`), boxPub: v.keys.boxHome.pub, regGen: 2 });
    const sign = signer("log");
    const r = P.applyRelayLog(P.emptyRelayLogState(APEX), [e1, e2].map((entry) => ({ entry, signature: P.signRelayLogEntry(APEX, entry, sign) })), v.keys.log.pub);
    expect(r.ok && P.relayLogBox(r.state, `a.alice.${APEX}`)).toBeNull();
    expect(r.ok && P.relayLogBox(r.state, `b.alice.${APEX}`)).toMatchObject({ regGen: 2 });
  });

  it("maps attachment refusals to the frame's codes", () => {
    expect(P.attachmentRefusalCode("future")).toBe("clock");
    expect(P.attachmentRefusalCode("expired")).toBe("clock");
    expect(P.attachmentRefusalCode("not-registered")).toBe("not-registered");
    expect(P.attachmentRefusalCode("revoked")).toBe("revoked");
    expect(P.attachmentRefusalCode("bad-signature")).toBe("mismatch");
    expect(P.attachmentRefusalCode("not-this-relay")).toBe("mismatch");
  });

  it("dispatches attachment items by kind", () => {
    const box = v.checks.boxAttachment[0];
    expect(P.checkAttachmentItem({ kind: "box", attachment: box.attachment, signature: box.signature }, ctx())).toEqual({ ok: true });
    expect(P.checkAttachmentItem({ kind: "legacy", attachment: box.attachment, signature: box.signature }, ctx())).toEqual({ ok: false, reason: "ttl-too-long" });
    const legacy = v.checks.legacyAttachment[0];
    expect(P.checkAttachmentItem({ kind: "legacy", attachment: legacy.attachment, signature: legacy.signature }, ctx())).toEqual({ ok: true });
    expect(P.checkAttachmentItem({ kind: "box", attachment: legacy.attachment, signature: legacy.signature }, ctx())).toEqual({ ok: false, reason: "bad-signature" });
    expect(P.checkAttachmentItem({ kind: "x" } as Any, ctx())).toEqual({ ok: false, reason: "malformed" });
  });

  it("verifies a blessing through the maintainer chain", () => {
    const b = v.blessings[0].blessing;
    expect(P.verifyRelayBlessingWithChain(b, null, T0, APEX, "ab".repeat(32))).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
    expect(P.verifyRelayBlessingWithChain(b, { authorizedCaKeys: () => CA }, T0, APEX, "ab".repeat(32))).toEqual({ ok: true });
    expect(P.relayMeshCaKeys({ authorizedCaKeys: () => [CA[0]!.toUpperCase()] }, T0, "ab".repeat(32))).toEqual(CA);
    expect(P.verifyRelayDirectoryWithChain(D, { authorizedCaKeys: () => CA }, T0, APEX, "ab".repeat(32))).toEqual({ ok: true, expired: false });
  });

  it("shape helpers", () => {
    expect(P.isPodName(`home.alice.${APEX}`, APEX)).toBe(true);
    expect(P.isPodName(`x.home.alice.${APEX}`, APEX)).toBe(false);
    expect(P.isPodName(`home.alice${APEX}`, APEX)).toBe(false);
    expect(P.accountOfPodName(`home.alice.${APEX}`, APEX)).toBe("alice");
    expect(P.isBarePhoneName(`alice.${APEX}`, APEX)).toBe(true);
    expect(P.isBarePhoneName(`home.alice.${APEX}`, APEX)).toBe(false);
    expect(P.isRelayId("iad1")).toBe(true);
    expect(P.isRelayId("i")).toBe(false);
    expect(P.isRelayId("a".repeat(32))).toBe(false);
    expect(P.relayTunnelHost("iad1", APEX)).toBe(`iad1.tunnel.${APEX}`);
    expect(P.directoryRelay(D, "ams1")?.relayKind).toBe("full");
    expect(P.directoryRelay(null, "ams1")).toBeNull();
  });
});

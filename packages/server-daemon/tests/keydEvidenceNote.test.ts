import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRankCanonicalBytes, deriveServiceMemberStableId, deriveServiceSecret, ed, signAppRank, signRevokeDeviceCapabilityGrant } from "@flagship/protocol";
import { AccessJournal, type AccessEntry } from "../src/accessJournal.js";
import { DeviceRevocations, type SignedRevocation } from "../src/deviceRevocations.js";
import { KeydCustodian } from "../src/keydCustodian.js";
import { startKeydWorker } from "./helpers/keydWorker.js";

const SEED = new Uint8Array(32).fill(0x33);
const SWK = new Uint8Array(32).fill(0x44);
const ROOT = new Uint8Array(32).fill(0x61);
const ROOT_PUB = ed.getPublicKey(ROOT);
const IRK_PUB = ed.getPublicKey(new Uint8Array(32).fill(0x62));
const DEV = Buffer.from(ed.getPublicKey(new Uint8Array(32).fill(0x63))).toString("hex");
const APP = "alice--chess";
const GRANT_ID = "0b6f2d3e-0000-4000-8000-000000000001";
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (privateKey: Uint8Array) => ({ privateKey, publicKey: ed.getPublicKey(privateKey) });

const grant = `flagship/device-capability-grant/v2|${GRANT_ID}|alice|dev-1|${DEV}|admin,apps|1|${Date.now() + 86_400_000}`;
const grantSig = hex(ed.sign(enc(grant), ROOT));
const me = deriveServiceMemberStableId(deriveServiceSecret(SWK, APP), Buffer.from(DEV, "hex"));
const inject = () => enc(`flagship/inject/v1|${APP}|${me}|master|${Date.now()}`);
const grantEvidence = { appId: APP, identityPubHex: DEV, statement: grant, signatureHex: grantSig };

let keyd: Awaited<ReturnType<typeof startKeydWorker>>;
let custodian: KeydCustodian;
const dirs: string[] = [];

beforeAll(async () => {
  keyd = await startKeydWorker({
    seed: SEED,
    swk: SWK,
    owner: { irkPubHex: hex(IRK_PUB), serverFqdn: "home.alice.flagship.services", adminRootPubHex: hex(ROOT_PUB) } as never,
  });
  custodian = new KeydCustodian({ socketPath: keyd.sock, component: "test" });
});
afterAll(async () => {
  custodian.close();
  await keyd.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "evnote-"));
  dirs.push(d);
  return d;
}

describe("keyd learns what the owner took back, through the daemon's own stores", () => {
  it("a rank order offered to the journal reaches keyd, and keyd then refuses the older master order", async () => {
    const raise = { serviceRef: APP, target: `device:${DEV}`, rank: "master", issuedAt: Date.now() - 2000 };
    const raiseEvidence = { appId: APP, identityPubHex: DEV, statement: new TextDecoder().decode(appRankCanonicalBytes(raise)), signatureHex: hex(signAppRank(raise, kp(ROOT))) };
    expect(() => custodian.signMasterIdentity(inject(), raiseEvidence)).not.toThrow();

    const journal = new AccessJournal(join(tmp(), "access-journal.json"));
    await journal.load();
    const seen: AccessEntry[] = [];
    journal.subscribe((_ref, e) => {
      seen.push(e);
      if (e.kind === "rank") custodian.noteEvidence({ statement: new TextDecoder().decode(appRankCanonicalBytes(e.order)), signatureHex: e.signature });
    });
    const demote = { serviceRef: APP, target: `device:${DEV}`, rank: "member", issuedAt: Date.now() - 1000 };
    await journal.add(APP, { kind: "rank", order: demote, signature: hex(signAppRank(demote, kp(ROOT))) });
    expect(seen).toHaveLength(1);
    expect(() => custodian.signMasterIdentity(inject(), raiseEvidence)).toThrow("(superseded)");
    expect(() => custodian.signMasterIdentity(inject(), grantEvidence)).toThrow("(superseded)");
  });

  it("an IRK-signed rank order is not kept where an admin root is pinned", () => {
    const o = { serviceRef: "alice--notes", target: `device:${DEV}`, rank: "member", issuedAt: Date.now() - 1000 };
    expect(() => custodian.noteEvidence({ statement: new TextDecoder().decode(appRankCanonicalBytes(o)), signatureHex: hex(signAppRank(o, kp(new Uint8Array(32).fill(0x62)))) })).toThrow("(bad-signature)");
  });

  it("a device revocation carries its signed statement and grant to keyd, is kept with them, and is handed over again after a restart", async () => {
    const path = join(tmp(), "device-revocations.json");
    const handed: SignedRevocation[] = [];
    const make = () =>
      new DeviceRevocations({
        path,
        username: "alice",
        adminRootPub: () => ROOT_PUB,
        grantOf: (id) => (id === GRANT_ID ? { statement: grant, signatureHex: grantSig } : null),
      });
    const revs = make();
    await revs.load();
    revs.subscribeSigned((r) => handed.push(r));
    const r = { grantId: GRANT_ID, username: "alice", reason: "lost" as const, issuedAt: Date.now() - 500 };
    expect(await revs.accept(r, signRevokeDeviceCapabilityGrant(r, kp(ROOT)))).toBeNull();
    expect(handed).toHaveLength(1);
    const h = handed[0]!;
    expect(ed.verify(Buffer.from(h.signatureHex, "hex"), enc(h.statement), ROOT_PUB)).toBe(true);
    expect(h.grantStatement).toBe(grant);

    const again = make();
    await again.load();
    expect(again.signedRevocations()).toEqual([h]);

    const { grantId: _id, ...note } = h;
    expect(custodian.noteEvidence(note)).toBe(true);
    expect(custodian.noteEvidence(note)).toBe(false);
    const raise = { serviceRef: "alice--notes", target: `device:${DEV}`, rank: "master", issuedAt: Date.now() - 2000 };
    const meNotes = deriveServiceMemberStableId(deriveServiceSecret(SWK, "alice--notes"), Buffer.from(DEV, "hex"));
    const ev = { appId: "alice--notes", identityPubHex: DEV, statement: new TextDecoder().decode(appRankCanonicalBytes(raise)), signatureHex: hex(signAppRank(raise, kp(ROOT))) };
    expect(() => custodian.signMasterIdentity(enc(`flagship/inject/v1|alice--notes|${meNotes}|master|${Date.now()}`), ev)).toThrow("(revoked)");
  });
});

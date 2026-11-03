/**
 * The relay directory and the attachment store (relay-mesh.md §3.3, §5): newest directory only, held blessings,
 * attachment validity and precedence, withdrawals and tombstones, purges the log forces, caps, and phone items.
 */
import { describe, expect, it } from "vitest";
import {
  ATTACH_TTL_MS,
  DIRECTORY_EXPIRED_UNHEALTHY_MS,
  DIRECTORY_TTL_MS,
  ed,
  PHONE_ROUTE_GRANT_TTL_MS,
  signRelayDirectory,
  signRelayMeshRecord,
  signServingRecord,
  type BoxAttachment,
  type BoxItem,
  type PhoneItem,
  RELAY_BLESSING_TTL_MS,
} from "@flagship/protocol";
import { MeshDirectory } from "../src/tunnel/mesh/directory.js";
import { AttachmentStore } from "../src/tunnel/mesh/attachments.js";
import { MeshFeed } from "../src/tunnel/mesh/feed.js";
import { signLegacyAttachment } from "../src/tunnel/mesh/legacy.js";
import { adminProof, APEX, hex, keypair, MeshFixture } from "./support/meshFixture.js";

function rig(o: { maxBoxItems?: number; maxPerRelay?: number } = {}) {
  const fx = new MeshFixture();
  let t = 10_000_000;
  fx.now = () => t;
  const ra = fx.addRelay("ra");
  const rb = fx.addRelay("rb");
  const re = fx.addRelay("re", "entry");
  fx.mintDirectory();
  const dir = new MeshDirectory({ servicesApex: APEX, caKeys: () => [fx.caPub], now: () => t });
  dir.offer(fx.directory);
  const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source(), now: () => t });
  const store = new AttachmentStore({ selfRelayId: "ra", servicesApex: APEX, ctx: () => ({ servicesApex: APEX, log: feed.state, directory: dir.current, now: t }), ...o });
  const sync = async () => {
    await feed.poll();
    store.onLogEntries(feed.entriesSince(0));
  };
  return { fx, dir, feed, store, ra, rb, re, sync, advance: (ms: number) => (t += ms), now: () => t };
}

function boxItem(pod: string, stk: ReturnType<typeof keypair>, relayId: string, issuedAt: number, o: Partial<BoxAttachment> = {}, signer = stk): BoxItem {
  const a: BoxAttachment = { serverFqdn: pod, boxPub: hex(stk.publicKey), regGen: 1, relayId, attachedAt: issuedAt, issuedAt, notAfter: issuedAt + ATTACH_TTL_MS, ...o };
  return { kind: "box", attachment: a, signature: signRelayMeshRecord("relay-attachment", a, (m) => ed.sign(m, signer.privateKey)) };
}

describe("mesh directory", () => {
  it("keeps the newest verified directory, never goes back, refuses a forged one, and turns unhealthy a day past expiry", () => {
    const { fx, dir, now, advance } = rig();
    const v1 = fx.directory!;
    fx.mintDirectory();
    expect(dir.offer(fx.directory)).toBe(true);
    expect(dir.version()).toBe(2);
    expect(dir.offer(v1)).toBe(false);
    const rogue = keypair();
    const forged = signRelayDirectory({ servicesApex: APEX, directoryVersion: 9, issuedAt: now(), expiresAt: now() + 1000, relays: [] }, rogue);
    expect(dir.offer(forged)).toBe(false);
    expect(dir.unhealthy()).toBe(false);
    advance(DIRECTORY_TTL_MS + DIRECTORY_EXPIRED_UNHEALTHY_MS);
    expect(dir.unhealthy()).toBe(true);
  });

  it("holds a blessing only while it is valid and names the directory's key", () => {
    const { fx, dir, ra, advance } = rig();
    expect(dir.offerBlessing(fx.blessings.get("ra"))).toBe(true);
    expect(dir.heldBlessing("ra")?.relayId).toBe("ra");
    const other = keypair();
    expect(dir.offerBlessing(fx.bless({ ...ra, key: other }))).toBe(false);
    advance(RELAY_BLESSING_TTL_MS + 3_600_000);
    expect(dir.heldBlessing("ra")).toBeNull();
  });
});

describe("attachment store", () => {
  it("keeps valid items, refuses forged / unregistered / wrong-regGen ones, and picks the winner by §5.2", async () => {
    const { fx, store, sync, now, ra, advance } = rig();
    const stk = keypair();
    const pod = `home.alice.${APEX}`;
    fx.registerBox(pod, hex(stk.publicKey));
    await sync();
    const thief = keypair();
    expect(store.offerAttachment(boxItem(pod, stk, "rb", now(), {}, thief), "rb")).toEqual({ ok: false, reason: "bad-signature" });
    expect(store.offerAttachment(boxItem(`ghost.alice.${APEX}`, stk, "rb", now()), "rb")).toEqual({ ok: false, reason: "not-registered" });
    expect(store.offerAttachment(boxItem(pod, stk, "rb", now(), { regGen: 2 }), "rb")).toEqual({ ok: false, reason: "mismatch" });
    expect(store.offerAttachment(boxItem(pod, stk, "rb", now(), { notAfter: now() + ATTACH_TTL_MS + 1 }), "rb")).toEqual({ ok: false, reason: "ttl-too-long" });
    const legacyB = signLegacyAttachment({ serverFqdn: pod, boxPub: hex(stk.publicKey), regGen: 1, relayId: "ra", attachedAt: now(), issuedAt: now() + 5, notAfter: now() + 60_000 }, (m) => ed.sign(m, ra.key.privateKey));
    expect(store.offerAttachment(legacyB, "ra").ok).toBe(true);
    const boxA = boxItem(pod, stk, "rb", now());
    expect(store.offerAttachment(boxA, "rb").ok).toBe(true);
    // Box-signed beats legacy even though the legacy one is newer.
    expect(store.winner(pod)?.attachment.relayId).toBe("rb");
    advance(10);
    const boxB = boxItem(pod, stk, "ra", now());
    expect(store.offerAttachment(boxB, "ra").ok).toBe(true);
    expect(store.winner(pod)?.attachment.relayId).toBe("ra");
    expect(store.ownWins(pod)).toBe(true);
    // A legacy attachment from an `entry` relay is refused.
    const fromEntry = signLegacyAttachment({ serverFqdn: pod, boxPub: hex(stk.publicKey), regGen: 1, relayId: "re", attachedAt: now(), issuedAt: now(), notAfter: now() + 60_000 }, (m) => ed.sign(m, fx.relays[2]!.key.privateKey));
    expect(store.offerAttachment(fromEntry, "re")).toEqual({ ok: false, reason: "not-full" });
  });

  it("a withdrawal removes only its own relay's items, ignores another relay's, and blocks a late older copy", async () => {
    const { fx, store, sync, now, rb, ra } = rig();
    const stk = keypair();
    const pod = `home.bob.${APEX}`;
    fx.registerBox(pod, hex(stk.publicKey));
    await sync();
    const item = boxItem(pod, stk, "rb", now());
    store.offerAttachment(item, "rb");
    const w = { subjectKind: "box" as const, subject: pod, relayId: "rb", withdrawnIssuedAt: item.attachment.issuedAt, at: now() };
    // Signed by ra for rb's attachment: ignored.
    expect(store.withdraw({ withdraw: w, signature: signRelayMeshRecord("relay-withdraw", w, (m) => ed.sign(m, ra.key.privateKey)) }, "ra")).toBe(false);
    expect(store.winner(pod)).not.toBeNull();
    expect(store.withdraw({ withdraw: w, signature: signRelayMeshRecord("relay-withdraw", w, (m) => ed.sign(m, rb.key.privateKey)) }, "rb")).toBe(true);
    expect(store.winner(pod)).toBeNull();
    // The same (older) attachment arriving again late, e.g. in a query answer, stays withdrawn.
    expect(store.offerAttachment(item, "rc")).toEqual({ ok: false, reason: "withdrawn" });
  });

  it("drops what the log invalidates: a revoked box, a re-registered name, a retired relay", async () => {
    const { fx, store, sync, now } = rig();
    const s1 = keypair();
    const s2 = keypair();
    const p1 = `home.carl.${APEX}`;
    const p2 = `cabin.carl.${APEX}`;
    fx.registerBox(p1, hex(s1.publicKey));
    fx.registerBox(p2, hex(s2.publicKey));
    await sync();
    store.offerAttachment(boxItem(p1, s1, "rb", now()), "rb");
    store.offerAttachment(boxItem(p2, s2, "rb", now()), "rb");
    expect(store.stats().boxItems).toBe(2);
    fx.append({ kind: "box-revoke", boxPub: hex(s1.publicKey), regGen: 1 });
    fx.registerBox(p2, hex(keypair().publicKey));
    await sync();
    expect(store.winner(p1)).toBeNull();
    expect(store.winner(p2)).toBeNull();
    const s3 = keypair();
    const p3 = `den.carl.${APEX}`;
    fx.registerBox(p3, hex(s3.publicKey));
    await sync();
    store.offerAttachment(boxItem(p3, s3, "rb", now()), "rb");
    fx.append({ kind: "relay-revoke", relayId: "rb", relayKey: hex(fx.relays[1]!.key.publicKey) });
    await sync();
    expect(store.winner(p3)).toBeNull();
    // And a new attachment naming the retired relay is refused.
    expect(store.offerAttachment(boxItem(p3, s3, "rb", now() + 1), "rb")).toEqual({ ok: false, reason: "relay-revoked" });
  });

  it("over a cap evicts the oldest item from another relay, never its own", async () => {
    const { fx, store, sync, now } = rig({ maxBoxItems: 2 });
    const keys = [keypair(), keypair(), keypair()];
    keys.forEach((k, i) => fx.registerBox(`b${i}.dan.${APEX}`, hex(k.publicKey)));
    await sync();
    store.offerAttachment(boxItem(`b0.dan.${APEX}`, keys[0]!, "ra", now()), "ra");
    store.offerAttachment(boxItem(`b1.dan.${APEX}`, keys[1]!, "rb", now() + 1), "rb");
    store.offerAttachment(boxItem(`b2.dan.${APEX}`, keys[2]!, "rb", now() + 2), "rb");
    expect(store.stats().boxItems).toBe(2);
    expect(store.winner(`b0.dan.${APEX}`)).not.toBeNull();
    expect(store.winner(`b1.dan.${APEX}`)).toBeNull();
  });

  it("phone items: valid only from their holder under the ledger's key; winner by generation; generations remembered", async () => {
    const { fx, store, ra, rb, now, sync } = rig();
    const admin = keypair();
    fx.authority("erin", hex(admin.publicKey), hex(keypair().publicKey));
    await sync();
    const phone = keypair();
    const g = { hostname: `erin.${APEX}`, phoneRoutePub: hex(phone.publicKey), generation: 3, holderRelayId: "rb", ledgerRelayId: "ra", issuedAt: now(), notAfter: now() + PHONE_ROUTE_GRANT_TTL_MS };
    const claim = { account: "erin", phoneRoutePub: g.phoneRoutePub, hostname: g.hostname, generation: 3, sessionNonce: "ab".repeat(16), issuedAt: now() };
    const claimSignature = hex(signServingRecord("route-claim", claim, (m) => ed.sign(m, phone.privateKey)));
    const grants = [adminProof("erin", admin, phone, { now: now() })];
    const item: PhoneItem = { kind: "phone", grant: g, signature: signRelayMeshRecord("phone-route-grant", g, (m) => ed.sign(m, ra.key.privateKey)), claim, claimSignature, grants };
    // §8.3: the key must be an admin device of the account under the log's admin root.
    expect(store.offerPhone({ ...item, grants: [] }, "rb")).toBe(false);
    expect(store.offerPhone({ ...item, grants: [adminProof("erin", keypair(), phone, { now: now() })] }, "rb")).toBe(false);
    expect(store.offerPhone({ ...item, grants: [adminProof("erin", admin, phone, { now: now(), scopes: ["browse"] })] }, "rb")).toBe(false);
    expect(store.offerPhone(item, "ra")).toBe(false); // announced by a relay that is not the holder
    expect(store.offerPhone({ ...item, signature: signRelayMeshRecord("phone-route-grant", g, (m) => ed.sign(m, rb.key.privateKey)) }, "rb")).toBe(false);
    expect(store.offerPhone(item, "rb")).toBe(true);
    expect(store.phoneWinner(g.hostname)?.grant.generation).toBe(3);
    expect(store.maxPhoneGeneration(g.hostname)).toBe(3);
    void fx;
  });
});

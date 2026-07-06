// "Replace this server" — webapp graceful-decommission client
// (docs/server-replacement-graceful-decommission.md §11.4 / §12 clients).
//
// Exercises the real shipping module lib/serverReplacement.js (dependency-
// injected, DOM-free):
//   1. its canonical bytes are byte-identical to @flagship/protocol's
//      signServerDecommission (the cross-platform pin in
//      packages/protocol/tests/serverDecommissionVectors.test.ts), so the broker
//      accepts what the webapp signs;
//   2. the deposit body shape ({ auth, authSignature, order, signature }) moves
//      through the REAL .com broker handler (InMemoryStorage) and records the
//      eviction, then the box can fetch its own order;
//   3. the pre-flight gate hard-blocks a wipe with no backup enrolled;
//   4. the disposition picker maps onto the order's diskDisposition / finalBackup;
//   5. L3 retires the instance locally on a successful deposit.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ed,
  verifyServerDecommission,
  type Keypair,
  type ServerDecommission,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handlePostDecommission,
  handleGetDecommission,
  type ServerDecommissionDeps,
} from "@flagship/control-plane";

const HOST = "home.alice.flagship.services";
const USERNAME = "alice";

async function loadLib() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "serverReplacement.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
/** A webapp signWithIrk(umk, bytes) backed by a fixed Ed25519 key. */
function signerFor(key: Keypair) {
  return async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, key.privateKey);
}

const ownerIrk = makeKey(11);
const boxStk = makeKey(33);

async function brokerStore(): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: USERNAME, irkPubHex: hex(ownerIrk.publicKey), claimedAt: 1 });
  await s.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: hex(boxStk.publicKey),
    registeredAt: 2,
  });
  return s;
}

function deps(s: InMemoryStorage, now: number): ServerDecommissionDeps {
  return {
    servers: s.servers,
    usernames: s.usernames,
    serverEvictions: s.serverEvictions,
    mailbox: {
      servers: s.servers,
      usernames: s.usernames,
      secretMailbox: s.secretMailbox,
      boxSealedLeases: s.boxSealedLeases,
      // The mailbox-auth freshness window is checked against THIS clock; the
      // webapp builds its auth with the same injected `now`, so a deterministic
      // test time keeps the auth fresh.
      now: () => now,
    },
    now: () => now,
  };
}

/** Route a webapp fetch(url, init) into the matching broker handler + the /pods
 *  directory read (for resolveReplacementContext). */
function brokerFetch(s: InMemoryStorage, now: number) {
  return async (url: string, init: any) => {
    const u = new URL(url);
    if (u.pathname.includes("/decommission")) {
      const body = init?.body ? JSON.parse(init.body) : {};
      const res = await handlePostDecommission(deps(s, now), HOST, body);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body };
    }
    if (u.pathname.endsWith("/pods")) {
      // Mirror the unauthenticated /pods directory: identityPubKey = box STK.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          pods: [{ serverDomain: HOST, identityPubKey: hex(boxStk.publicKey) }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };
}

describe("replace-this-server — webapp", () => {
  it("order canonical bytes verify under @flagship/protocol (the cross-platform pin)", async () => {
    const lib = await loadLib();
    const order: ServerDecommission = {
      podCanonical: HOST,
      retiredStkPubHex: hex(boxStk.publicKey),
      finalBackup: true,
      diskDisposition: "wipe-after-handoff",
      backupEpoch: 7,
      nonce: "deadbeef".repeat(8),
      issuedAt: 1700,
    };
    const bytes = lib.canonicalDecommissionBytes(order);
    const sig = ed.sign(bytes, ownerIrk.privateKey);
    expect(verifyServerDecommission(order, sig, ownerIrk.publicKey)).toBe(true);

    // And matches the literal pinned vector string (lowercasing + "1" encoding).
    const expected =
      "flagship/server-decommission/v1|" +
      HOST +
      "|" +
      hex(boxStk.publicKey) +
      "|1|wipe-after-handoff|7|" +
      "deadbeef".repeat(8) +
      "|1700";
    expect(new TextDecoder().decode(bytes)).toBe(expected);
  });

  it("buildDecommissionOrder maps the disposition picker onto diskDisposition + finalBackup", async () => {
    const lib = await loadLib();
    const base = {
      serverDomain: HOST,
      retiredStkPubHex: hex(boxStk.publicKey),
      now: () => 5000,
    };

    // keep + no backup → finalBackup false, epoch 0.
    const keep = lib.buildDecommissionOrder({ ...base, disposition: "keep", backupEnrolled: false });
    expect(keep.diskDisposition).toBe("keep");
    expect(keep.finalBackup).toBe(false);
    expect(keep.backupEpoch).toBe(0);

    // keep + enrolled → still flushes a final backup.
    const keepEnrolled = lib.buildDecommissionOrder({ ...base, disposition: "keep", backupEnrolled: true });
    expect(keepEnrolled.finalBackup).toBe(true);
    expect(keepEnrolled.backupEpoch).toBe(5000);

    // wipe-after-handoff → always a final flush; fresh epoch.
    const wah = lib.buildDecommissionOrder({ ...base, disposition: "wipe-after-handoff", backupEnrolled: false });
    expect(wah.diskDisposition).toBe("wipe-after-handoff");
    expect(wah.finalBackup).toBe(true);
    expect(wah.backupEpoch).toBe(5000);

    // wipe-now → final flush + the disposition.
    const wn = lib.buildDecommissionOrder({ ...base, disposition: "wipe-now", backupEnrolled: false });
    expect(wn.diskDisposition).toBe("wipe-now");
    expect(wn.finalBackup).toBe(true);
  });

  it("pre-flight gate hard-blocks a wipe when no backup is enrolled; keep is always allowed", async () => {
    const lib = await loadLib();
    expect(lib.preflightGate({ disposition: "keep", backupEnrolled: false }).blocked).toBe(false);
    expect(lib.preflightGate({ disposition: "wipe-after-handoff", backupEnrolled: false }).blocked).toBe(true);
    expect(lib.preflightGate({ disposition: "wipe-now", backupEnrolled: false }).blocked).toBe(true);
    // Enrolled → wipes pass the gate.
    expect(lib.preflightGate({ disposition: "wipe-after-handoff", backupEnrolled: true }).blocked).toBe(false);
    expect(lib.preflightGate({ disposition: "wipe-now", backupEnrolled: true }).blocked).toBe(false);
    // The block carries the spec's exact copy.
    const r = lib.preflightGate({ disposition: "wipe-after-handoff", backupEnrolled: false });
    expect(r.reason).toMatch(/no backup/i);
    expect(r.reason).toMatch(/wipe-now/);
  });

  it("isBackupEnrolled fails closed on an unknown / unreadable choice", async () => {
    const lib = await loadLib();
    expect(lib.isBackupEnrolled("enabled")).toBe(true);
    expect(lib.isBackupEnrolled(true)).toBe(true);
    expect(lib.isBackupEnrolled("none")).toBe(false);
    expect(lib.isBackupEnrolled(null)).toBe(false);
    expect(lib.isBackupEnrolled(undefined)).toBe(false);
    expect(lib.isBackupEnrolled("")).toBe(false);
  });

  it("resolveReplacementContext reads the box STK off /pods", async () => {
    const lib = await loadLib();
    const s = await brokerStore();
    const now = 1_000_000;
    const ctx = await lib.resolveReplacementContext(
      { serverDomain: HOST, username: USERNAME },
      { fetch: brokerFetch(s, now), origin: "https://x", peerBackupChoice: "enabled" },
    );
    expect(ctx.retiredStkPubHex).toBe(hex(boxStk.publicKey));
    expect(ctx.backupEnrolled).toBe(true);
  });

  it("deposit body shape moves through the real broker + the box can fetch its order", async () => {
    const lib = await loadLib();
    const s = await brokerStore();
    const now = 1_000_000;
    const fetchImpl = brokerFetch(s, now);

    const out = await lib.depositDecommission(
      {
        serverDomain: HOST,
        username: USERNAME,
        retiredStkPubHex: hex(boxStk.publicKey),
        disposition: "wipe-after-handoff",
        backupEnrolled: true,
        umk: new Uint8Array(32),
        irkPubHex: hex(ownerIrk.publicKey),
        signWithIrk: signerFor(ownerIrk),
      },
      { fetch: fetchImpl, origin: "https://x", now: () => now },
    );
    expect(out.ok).toBe(true);
    expect(out.order.diskDisposition).toBe("wipe-after-handoff");

    // The retiring box fetches ITS OWN order (revoke-tolerant GET) and re-verifies.
    const got = await handleGetDecommission(deps(s, now), HOST, hex(boxStk.publicKey));
    expect(got.status).toBe(200);
    const stored = JSON.parse((got.body as { orderJson: string }).orderJson) as ServerDecommission;
    expect(stored.retiredStkPubHex).toBe(hex(boxStk.publicKey).toLowerCase());
    const storedSig = Buffer.from((got.body as { orderSignatureHex: string }).orderSignatureHex, "hex");
    expect(verifyServerDecommission(stored, storedSig, ownerIrk.publicKey)).toBe(true);
  });

  it("deposit refuses without the box STK (box must be reachable)", async () => {
    const lib = await loadLib();
    await expect(
      lib.depositDecommission(
        {
          serverDomain: HOST,
          username: USERNAME,
          retiredStkPubHex: null,
          disposition: "keep",
          backupEnrolled: false,
          umk: new Uint8Array(32),
          irkPubHex: hex(ownerIrk.publicKey),
          signWithIrk: signerFor(ownerIrk),
        },
        { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), now: () => 1 },
      ),
    ).rejects.toThrow(/current key|online/i);
  });

  it("L3: runReplacement retires the instance locally on a successful deposit", async () => {
    const lib = await loadLib();
    const s = await brokerStore();
    const now = 1_000_000;

    // An in-memory profilesStore stand-in (the slot is a JSON string).
    const slots: Record<string, string> = {};
    const profileGet = (k: string) => slots[k] ?? null;
    const profileSet = (k: string, v: string | null) => {
      if (v == null) delete slots[k];
      else slots[k] = String(v);
    };

    expect(lib.isServerDecommissioned(HOST, { profileGet })).toBe(false);

    const res = await lib.runReplacement(
      {
        serverDomain: HOST,
        username: USERNAME,
        retiredStkPubHex: hex(boxStk.publicKey),
        disposition: "keep",
        backupEnrolled: false,
        umk: new Uint8Array(32),
        irkPubHex: hex(ownerIrk.publicKey),
        signWithIrk: signerFor(ownerIrk),
      },
      { fetch: brokerFetch(s, now), origin: "https://x", now: () => now, profileGet, profileSet },
    );
    expect(res.ok).toBe(true);

    // The instance is now suppressed locally; case-insensitive.
    expect(lib.isServerDecommissioned(HOST, { profileGet })).toBe(true);
    expect(lib.isServerDecommissioned(HOST.toUpperCase(), { profileGet })).toBe(true);
    expect(lib.decommissionedServers({ profileGet })).toContain(HOST.toLowerCase());
  });

  it("a deposit failure does NOT retire the instance locally", async () => {
    const lib = await loadLib();
    const slots: Record<string, string> = {};
    const profileGet = (k: string) => slots[k] ?? null;
    const profileSet = (k: string, v: string | null) => {
      if (v == null) delete slots[k];
      else slots[k] = String(v);
    };
    await expect(
      lib.runReplacement(
        {
          serverDomain: HOST,
          username: USERNAME,
          retiredStkPubHex: hex(boxStk.publicKey),
          disposition: "keep",
          backupEnrolled: false,
          umk: new Uint8Array(32),
          irkPubHex: hex(ownerIrk.publicKey),
          signWithIrk: signerFor(ownerIrk),
        },
        {
          fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
          origin: "https://x",
          profileGet,
          profileSet,
        },
      ),
    ).rejects.toThrow();
    expect(lib.isServerDecommissioned(HOST, { profileGet })).toBe(false);
  });
});

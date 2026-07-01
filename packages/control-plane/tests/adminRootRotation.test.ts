/**
 * Slice D §5 — admin master-root recovery rotation apply + served lane
 * (docs/device-admin-tier-spec.md). Pure handlers + InMemoryStorage; no network.
 *
 * Covered:
 *   - a valid old-root-signed proof APPLIES: stored admin root re-pins + the
 *     signed proof lands on the served lane
 *   - a rotation NOT signed by the current root is REJECTED (stored root
 *     unchanged)
 *   - the chain REPLAYS: two consecutive rotations produce an ordered 2-hop lane
 *   - idempotency: re-POSTing a rotation whose `new` is already current is a
 *     no-op 200 (no duplicate lane entry)
 *   - guards: no admin root → 400, new == old → 400, doesn't chain → 409
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signAdminRootRotation,
  type AdminRootRotation,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleApplyAdminRootRotation,
  handleListAdminRootRotations,
  type AdminRootRotationDeps,
} from "../src/adminRootRotation.js";

const USER = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function mkDeps(adminRoot: Keypair | null): Promise<{
  deps: AdminRootRotationDeps;
  storage: InMemoryStorage;
}> {
  const storage = new InMemoryStorage();
  const irk = makeKey();
  await storage.usernames.put({
    username: USER,
    irkPubHex: hex(irk.publicKey),
    claimedAt: 1,
    ...(adminRoot ? { adminRootPubHex: hex(adminRoot.publicKey) } : {}),
  });
  return {
    storage,
    deps: { usernames: storage.usernames, rotations: storage.adminRootRotations },
  };
}

/** Build the on-the-wire apply body for `old → new`, signed by `signer`. */
function applyBody(
  oldKp: Keypair,
  newKp: Keypair,
  issuedAt: number,
  signer: Keypair = oldKp,
) {
  const rotation: AdminRootRotation = {
    username: USER,
    oldAdminRootPub: oldKp.publicKey,
    newAdminRootPub: newKp.publicKey,
    issuedAt,
  };
  const sig = signAdminRootRotation(rotation, signer);
  return {
    rotation: {
      username: USER,
      oldAdminRootPub: hex(oldKp.publicKey),
      newAdminRootPub: hex(newKp.publicKey),
      issuedAt,
    },
    signatureHex: hex(sig),
  };
}

describe("handleApplyAdminRootRotation", () => {
  it("a valid old-root-signed proof re-pins the stored root and appends to the lane", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const { deps, storage } = await mkDeps(a0);

    const res = await handleApplyAdminRootRotation(deps, USER, applyBody(a0, a1, 1000));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: true, adminRootPub: hex(a1.publicKey), seq: 1 });

    // The stored authority root moved.
    const rec = await storage.usernames.get(USER);
    expect(rec?.adminRootPubHex).toBe(hex(a1.publicKey));

    // The signed proof is on the served lane.
    const listed = await handleListAdminRootRotations(deps, USER);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      username: USER,
      rotations: [
        {
          seq: 1,
          oldAdminRootPub: hex(a0.publicKey),
          newAdminRootPub: hex(a1.publicKey),
        },
      ],
    });
  });

  it("rejects a rotation NOT signed by the current root and leaves the stored root untouched", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const evil = makeKey();
    const { deps, storage } = await mkDeps(a0);

    // Same old/new, but signed by a key that is NOT the pinned current root.
    const res = await handleApplyAdminRootRotation(deps, USER, applyBody(a0, a1, 1000, evil));
    expect(res.status).toBe(403);

    const rec = await storage.usernames.get(USER);
    expect(rec?.adminRootPubHex).toBe(hex(a0.publicKey));
    const listed = await handleListAdminRootRotations(deps, USER);
    expect((listed.body as { rotations: unknown[] }).rotations).toHaveLength(0);
  });

  it("replays a two-hop chain in order (old → A1 → A2)", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const a2 = makeKey();
    const { deps, storage } = await mkDeps(a0);

    expect((await handleApplyAdminRootRotation(deps, USER, applyBody(a0, a1, 1000))).status).toBe(200);
    // The second hop is signed by A1 (the now-current root).
    expect((await handleApplyAdminRootRotation(deps, USER, applyBody(a1, a2, 2000))).status).toBe(200);

    expect((await storage.usernames.get(USER))?.adminRootPubHex).toBe(hex(a2.publicKey));
    const listed = await handleListAdminRootRotations(deps, USER);
    const chain = (listed.body as { rotations: { seq: number; oldAdminRootPub: string; newAdminRootPub: string }[] }).rotations;
    expect(chain.map((r) => r.seq)).toEqual([1, 2]);
    expect(chain[0]!.newAdminRootPub).toBe(hex(a1.publicKey));
    expect(chain[1]!.oldAdminRootPub).toBe(hex(a1.publicKey));
    expect(chain[1]!.newAdminRootPub).toBe(hex(a2.publicKey));
  });

  it("is idempotent: re-POSTing an already-applied rotation is a no-op 200 (no duplicate lane entry)", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const { deps, storage } = await mkDeps(a0);

    await handleApplyAdminRootRotation(deps, USER, applyBody(a0, a1, 1000));
    // A1 is already current ⇒ new === current ⇒ no-op.
    const again = await handleApplyAdminRootRotation(deps, USER, applyBody(a0, a1, 1000));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, applied: false, adminRootPub: hex(a1.publicKey) });

    expect((await storage.usernames.get(USER))?.adminRootPubHex).toBe(hex(a1.publicKey));
    const listed = await handleListAdminRootRotations(deps, USER);
    expect((listed.body as { rotations: unknown[] }).rotations).toHaveLength(1);
  });

  it("rejects when the account has no admin root pinned (400)", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const { deps } = await mkDeps(null); // no admin root
    const res = await handleApplyAdminRootRotation(deps, USER, applyBody(a0, a1, 1000));
    expect(res.status).toBe(400);
  });

  it("rejects new == old (400)", async () => {
    const a0 = makeKey();
    const { deps } = await mkDeps(a0);
    const res = await handleApplyAdminRootRotation(deps, USER, applyBody(a0, a0, 1000));
    expect(res.status).toBe(400);
  });

  it("rejects a proof that does not chain to the current root (409)", async () => {
    const a0 = makeKey();
    const other = makeKey();
    const target = makeKey();
    const { deps, storage } = await mkDeps(a0);
    // old = `other` (≠ pinned a0), new = target → does not chain.
    const res = await handleApplyAdminRootRotation(deps, USER, applyBody(other, target, 1000));
    expect(res.status).toBe(409);
    expect((await storage.usernames.get(USER))?.adminRootPubHex).toBe(hex(a0.publicKey));
  });

  it("404s an unregistered username", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const { deps } = await mkDeps(a0);
    const res = await handleApplyAdminRootRotation(deps, "nobody", {
      rotation: {
        username: "nobody",
        oldAdminRootPub: hex(a0.publicKey),
        newAdminRootPub: hex(a1.publicKey),
        issuedAt: 1,
      },
      signatureHex: hex(signAdminRootRotation(
        { username: "nobody", oldAdminRootPub: a0.publicKey, newAdminRootPub: a1.publicKey, issuedAt: 1 },
        a0,
      )),
    });
    expect(res.status).toBe(404);
  });
});

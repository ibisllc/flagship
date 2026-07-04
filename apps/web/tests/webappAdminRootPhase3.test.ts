// Slice D — Phase 3 (webapp) CLIENT:
//   1. Promote-a-device: the admin add-device bundle carries `wrappedAdminRoot`
//      ONLY when promote is on, and the incoming side stores it → admin device.
//   2. Recovery restore: the escrowed admin root is stored device-local under
//      the account's own profile record on recover.
//   3. Rotate admin root: byte-identical canonical bytes, OLD-signs-OLD→NEW, and
//      the `.com` POST shape.
//
// The canonical bytes + signature are proven wire-compatible with the TS spine
// (@flagship/protocol verifyAdminRootRotation) — a webapp-signed rotation MUST
// verify there, byte-for-byte.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed, verifyAdminRootRotation, type AdminRootRotation } from "@flagship/protocol";

/* ---------- module loaders (exercise the shipped JS) ---------- */

function loadWebapp(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}
const loadPairing = () => loadWebapp("lib/crossDevicePairing.js");
const loadKeystore = () => loadWebapp("keystore.js");
const loadRotation = () => loadWebapp("lib/adminRootRotation.js");
const loadRecovery = () => loadWebapp("lib/recovery.js");

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function fakeRelay() {
  const calls: any = {};
  return {
    calls,
    relay: {
      open: vi.fn(async () => ({ sid: "SID1", pkB64u: "ADMINPK" })),
      onSas: vi.fn(),
      awaitConfirm: vi.fn(async () => true),
      receivePeerPub: vi.fn(async () => "ab".repeat(32)),
      seal: vi.fn(async (bytes: Uint8Array) => { calls.sealed = bytes; }),
      close: vi.fn(),
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 * 1. Promote-a-device — the bundle carries wrappedAdminRoot only when ON.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("Phase 3 — promote-a-device (seal-root, assurance-gated)", () => {
  async function seal(promoteAdmin: boolean, adminRootSeed: Uint8Array | null) {
    const k = await loadKeystore();
    const { runAdminAddDevice } = await loadPairing();
    const { relay, calls } = fakeRelay();
    const out = await runAdminAddDevice({
      username: "harry",
      seed: new Uint8Array(32).fill(0x42),
      signWithIrk: (s: Uint8Array, b: Uint8Array) => k.signWithIrk(s, b),
      bytesToHex: k.bytesToHex,
      promoteAdmin,
      adminRootSeed,
      relay,
      now: () => 7000,
    });
    const bundle = JSON.parse(new TextDecoder().decode(calls.sealed));
    return { out, bundle };
  }

  it("promote OFF → NO wrappedAdminRoot in the bundle; parse yields adminRootSeed null", async () => {
    const { out, bundle } = await seal(false, new Uint8Array(32).fill(7));
    expect(bundle).not.toHaveProperty("wrappedAdminRoot");
    expect(out.promotedAdmin).toBe(false);

    const { parseSealedBundle } = await loadPairing();
    const parsed = parseSealedBundle(JSON.stringify(bundle));
    expect(parsed.adminRootSeed).toBeNull();
  });

  it("promote ON → wrappedAdminRoot rides the bundle and round-trips through parse", async () => {
    const adminSeed = new Uint8Array(32).fill(0x99);
    const { out, bundle } = await seal(true, adminSeed);
    expect(bundle.wrappedAdminRoot).toBe(toHex(adminSeed));
    expect(out.promotedAdmin).toBe(true);

    const { parseSealedBundle } = await loadPairing();
    const parsed = parseSealedBundle(JSON.stringify(bundle));
    expect(parsed.adminRootSeed).toBeInstanceOf(Uint8Array);
    expect(toHex(parsed.adminRootSeed)).toBe(toHex(adminSeed));
  });

  it("promote ON with NO/short admin root → hard error (never silently drop the grant)", async () => {
    await expect(seal(true, null)).rejects.toThrow(/no admin root/);
    await expect(seal(true, new Uint8Array(16))).rejects.toThrow(/no admin root/);
  });

  it("parseSealedBundle rejects a malformed wrappedAdminRoot", async () => {
    const { parseSealedBundle } = await loadPairing();
    const base = {
      umkSeedHex: "55".repeat(32),
      admit: { username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1 },
      admitSig: "cc".repeat(64),
    };
    expect(() => parseSealedBundle(JSON.stringify({ ...base, wrappedAdminRoot: "xyz" })))
      .toThrow(/wrappedAdminRoot/);
  });
});

describe("Phase 3 — runIncomingJoin stores the admin root iff present", () => {
  function incomingDeps(overrides: Record<string, unknown> = {}) {
    return {
      deviceIrkPubHex: "ab".repeat(32),
      setActiveKeystoreProfile: vi.fn(),
      persistSeedForProfile: vi.fn(async () => {}),
      persistAdminRootSeed: vi.fn(async () => {}),
      unlockSession: vi.fn(async () => {}),
      fetchAccountIrkPubHex: vi.fn(async () => "dd".repeat(32)),
      verifyAdmit: vi.fn(async () => true),
      verifyEd25519: vi.fn(async () => true),
      registerPush: vi.fn(async () => ({ request: { username: "harry" }, signatureHex: "00" })),
      postDeviceAdmit: vi.fn(async () => ({ quarantineUntil: 0 })),
      addProfile: vi.fn(),
      setUsername: vi.fn(),
      now: () => 1000,
      ...overrides,
    };
  }

  function bundle(withAdmin: boolean) {
    return JSON.stringify({
      umkSeedHex: "55".repeat(32),
      admit: { username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1 },
      admitSig: "cc".repeat(64),
      ...(withAdmin ? { wrappedAdminRoot: "99".repeat(32) } : {}),
    });
  }

  it("no wrappedAdminRoot → persistAdminRootSeed is NOT called; not promoted", async () => {
    const { runIncomingJoin } = await loadPairing();
    const deps: any = incomingDeps();
    const out = await runIncomingJoin({ bundlePlaintext: bundle(false), ...deps });
    expect(deps.persistAdminRootSeed).not.toHaveBeenCalled();
    expect(out.promotedAdmin).toBe(false);
  });

  it("wrappedAdminRoot present → persistAdminRootSeed(seed, adminSeed) BEFORE unlockSession", async () => {
    const { runIncomingJoin } = await loadPairing();
    const order: string[] = [];
    const deps: any = incomingDeps({
      persistAdminRootSeed: vi.fn(async () => { order.push("persistAdmin"); }),
      unlockSession: vi.fn(async () => { order.push("unlock"); }),
    });
    const out = await runIncomingJoin({ bundlePlaintext: bundle(true), ...deps });
    expect(deps.persistAdminRootSeed).toHaveBeenCalledTimes(1);
    const [umk, adminSeed] = deps.persistAdminRootSeed.mock.calls[0];
    expect(toHex(umk)).toBe("55".repeat(32));
    expect(toHex(adminSeed)).toBe("99".repeat(32));
    expect(order).toEqual(["persistAdmin", "unlock"]);
    expect(out.promotedAdmin).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. Recovery restore — the escrowed admin root is stored device-local.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("Phase 3 — recovery restore stores the escrowed admin root", () => {
  it("persistRecoveredAdminRoot stores under profileIdFromCloudName(username)", async () => {
    const { persistRecoveredAdminRoot } = await loadRecovery();
    const k = await loadKeystore();
    const persist = vi.fn(async () => {});
    const umkSeed = new Uint8Array(32).fill(1);
    const adminRootSeed = new Uint8Array(32).fill(2);
    await persistRecoveredAdminRoot({ umkSeed, adminRootSeed, username: "Harry", persist });
    expect(persist).toHaveBeenCalledTimes(1);
    const [gotUmk, gotAdmin, profileId] = persist.mock.calls[0];
    expect(toHex(gotUmk)).toBe(toHex(umkSeed));
    expect(toHex(gotAdmin)).toBe(toHex(adminRootSeed));
    expect(profileId).toBe(k.profileIdFromCloudName("Harry"));
  });

  it("rejects a malformed recovered admin root", async () => {
    const { persistRecoveredAdminRoot } = await loadRecovery();
    await expect(persistRecoveredAdminRoot({
      umkSeed: new Uint8Array(32), adminRootSeed: new Uint8Array(16), username: "x", persist: vi.fn(),
    })).rejects.toThrow(/32 bytes/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 3. Rotate admin root — canonical bytes + OLD-signs-OLD→NEW + POST shape.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("Phase 3 — rotate-admin-root", () => {
  it("canonical bytes match flagship/admin-root-rotation/v1|u|old|new|issuedAt", async () => {
    const { adminRootRotationCanonicalBytes, TAG_ADMIN_ROOT_ROTATION } = await loadRotation();
    const r = {
      username: "harry",
      oldAdminRootPub: "11".repeat(32),
      newAdminRootPub: "22".repeat(32),
      issuedAt: 1735689600000,
    };
    const str = new TextDecoder().decode(adminRootRotationCanonicalBytes(r));
    expect(str).toBe(
      `${TAG_ADMIN_ROOT_ROTATION}|harry|${"11".repeat(32)}|${"22".repeat(32)}|1735689600000`,
    );
    expect(TAG_ADMIN_ROOT_ROTATION).toBe("flagship/admin-root-rotation/v1");
  });

  it("rejects a '|' in the username field (canonical guard)", async () => {
    const { adminRootRotationCanonicalBytes } = await loadRotation();
    expect(() => adminRootRotationCanonicalBytes({
      username: "ha|rry", oldAdminRootPub: "11".repeat(32), newAdminRootPub: "22".repeat(32), issuedAt: 1,
    })).toThrow(/separator/);
  });

  it("signs OLD→NEW (verifies under @flagship/protocol) and POSTs the spec body", async () => {
    const k = await loadKeystore();
    const { runRotateAdminRoot } = await loadRotation();

    // The OLD admin-root seed IS a raw Ed25519 seed; the fresh NEW one is minted
    // deterministically for the test.
    const oldSeed = new Uint8Array(32).fill(0x11);
    const newSeed = new Uint8Array(32).fill(0x22);

    const order: string[] = [];
    const posted: any[] = [];
    const persisted: any[] = [];
    const session: any = { adminRootSeed: oldSeed };
    let reEscrowed = "";
    let seedAtReEscrow = "";

    const result = await runRotateAdminRoot({
      username: "harry",
      umkSeed: new Uint8Array(32).fill(0xaa),
      currentAdminRootSeed: oldSeed,
      session,
      adminRootPubHex: k.adminRootPubHex,
      signWithAdminRoot: k.signWithAdminRoot,
      bytesToHex: k.bytesToHex,
      mintSeed: () => newSeed,
      now: () => 1735689600000,
      postAdminRootRotation: vi.fn(async (args: any) => { order.push("post"); posted.push(args); }),
      persistAdminRootSeed: vi.fn(async (umk: Uint8Array, s: Uint8Array) => { order.push("persist"); persisted.push([umk, s]); }),
      reEscrow: vi.fn(async (u: string) => {
        order.push("reEscrow");
        reEscrowed = u;
        // Snapshot what a real re-escrow would wrap: the session must already
        // carry the NEW seed, or the escrow would re-wrap the dead OLD root.
        seedAtReEscrow = toHex(session.adminRootSeed);
      }),
    });

    // The pubkeys the webapp derived match the raw-seed Ed25519 pubkeys.
    expect(result.oldAdminRootPub).toBe(toHex(ed.getPublicKey(oldSeed)));
    expect(result.newAdminRootPub).toBe(toHex(ed.getPublicKey(newSeed)));

    // POST body shape: { rotation: { username, oldAdminRootPub, newAdminRootPub, issuedAt }, signatureHex }.
    expect(posted).toHaveLength(1);
    const call = posted[0];
    expect(call.username).toBe("harry");
    expect(call.rotation).toEqual({
      username: "harry",
      oldAdminRootPub: result.oldAdminRootPub,
      newAdminRootPub: result.newAdminRootPub,
      issuedAt: 1735689600000,
    });
    expect(typeof call.signatureHex).toBe("string");

    // The signature verifies under the OLD root via the TS spine — byte-identical.
    const rotation: AdminRootRotation = {
      username: "harry",
      oldAdminRootPub: ed.getPublicKey(oldSeed),
      newAdminRootPub: ed.getPublicKey(newSeed),
      issuedAt: 1735689600000,
    };
    expect(verifyAdminRootRotation(rotation, fromHex(call.signatureHex), ed.getPublicKey(oldSeed))).toBe(true);
    // NOT under the new root.
    expect(verifyAdminRootRotation(rotation, fromHex(call.signatureHex), ed.getPublicKey(newSeed))).toBe(false);

    // POST happens BEFORE local re-store; the session + persistence adopt the NEW root.
    expect(order).toEqual(["post", "persist", "reEscrow"]);
    expect(toHex(persisted[0][1])).toBe(toHex(newSeed));
    expect(toHex(session.adminRootSeed)).toBe(toHex(newSeed));
    expect(reEscrowed).toBe("harry");
    // reEscrow ran AFTER persist + session update and saw the NEW seed.
    expect(seedAtReEscrow).toBe(toHex(newSeed));
    expect(result.reEscrow).toBe("ok");
  });

  it("a failed POST leaves the OLD root in place (no half-rotation)", async () => {
    const k = await loadKeystore();
    const { runRotateAdminRoot } = await loadRotation();
    const oldSeed = new Uint8Array(32).fill(0x11);
    const session: any = { adminRootSeed: oldSeed };
    const persist = vi.fn(async () => {});
    await expect(runRotateAdminRoot({
      username: "harry",
      umkSeed: new Uint8Array(32).fill(0xaa),
      currentAdminRootSeed: oldSeed,
      session,
      adminRootPubHex: k.adminRootPubHex,
      signWithAdminRoot: k.signWithAdminRoot,
      bytesToHex: k.bytesToHex,
      mintSeed: () => new Uint8Array(32).fill(0x22),
      postAdminRootRotation: vi.fn(async () => { throw new Error("rotation failed (500)"); }),
      persistAdminRootSeed: persist,
    })).rejects.toThrow(/rotation failed/);
    expect(persist).not.toHaveBeenCalled();
    expect(toHex(session.adminRootSeed)).toBe(toHex(oldSeed)); // unchanged
  });

  it("a non-admin device (no admin root) can't rotate", async () => {
    const { runRotateAdminRoot } = await loadRotation();
    await expect(runRotateAdminRoot({
      username: "harry",
      umkSeed: new Uint8Array(32).fill(0xaa),
      currentAdminRootSeed: null,
      loadAdminRootSeed: async () => null,
    })).rejects.toThrow(/isn't an admin device/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 4. Re-escrow the NEW root after rotation — observable, still best-effort.
 * ═══════════════════════════════════════════════════════════════════════ */

const loadAccountSecurityView = () => loadWebapp("views/account-security.js");

function rotationDeps(k: any, overrides: Record<string, unknown> = {}) {
  const oldSeed = new Uint8Array(32).fill(0x11);
  return {
    username: "harry",
    umkSeed: new Uint8Array(32).fill(0xaa),
    currentAdminRootSeed: oldSeed,
    session: { adminRootSeed: oldSeed } as any,
    adminRootPubHex: k.adminRootPubHex,
    signWithAdminRoot: k.signWithAdminRoot,
    bytesToHex: k.bytesToHex,
    mintSeed: () => new Uint8Array(32).fill(0x22),
    postAdminRootRotation: vi.fn(async () => {}),
    persistAdminRootSeed: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("Phase 3 — post-rotation re-escrow status (D-3 seam)", () => {
  it("a throwing reEscrow NEVER fails the rotation → resolves with reEscrow:'failed'", async () => {
    const k = await loadKeystore();
    const { runRotateAdminRoot } = await loadRotation();
    const persist = vi.fn(async () => {});
    const deps = rotationDeps(k, {
      persistAdminRootSeed: persist,
      reEscrow: vi.fn(async () => { throw new Error("popup blocked"); }),
    });
    const result = await runRotateAdminRoot(deps);
    expect(result.reEscrow).toBe("failed");
    // The rotation itself fully landed: persisted + session on the NEW seed.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(toHex((deps.session as any).adminRootSeed)).toBe("22".repeat(32));
  });

  it("no reEscrow dep → reEscrow:'skipped'", async () => {
    const k = await loadKeystore();
    const { runRotateAdminRoot } = await loadRotation();
    const result = await runRotateAdminRoot(rotationDeps(k));
    expect(result.reEscrow).toBe("skipped");
  });

  it("makeRotationReEscrow: not-enrolled resolves clean, setupCloudRecovery never called → 'ok'", async () => {
    const k = await loadKeystore();
    const { runRotateAdminRoot } = await loadRotation();
    const { makeRotationReEscrow } = await loadAccountSecurityView();
    const setup = vi.fn(async () => {});
    const result = await runRotateAdminRoot(rotationDeps(k, {
      reEscrow: makeRotationReEscrow({
        hasCloudRecovery: vi.fn(async () => false),
        setupCloudRecovery: setup,
      }),
    }));
    expect(setup).not.toHaveBeenCalled();
    expect(result.reEscrow).toBe("ok");
  });

  it("makeRotationReEscrow: enrolled + setup succeeds → 'ok', setup called with the username", async () => {
    const k = await loadKeystore();
    const { runRotateAdminRoot } = await loadRotation();
    const { makeRotationReEscrow } = await loadAccountSecurityView();
    const setup = vi.fn(async () => {});
    const result = await runRotateAdminRoot(rotationDeps(k, {
      reEscrow: makeRotationReEscrow({
        hasCloudRecovery: vi.fn(async () => true),
        setupCloudRecovery: setup,
      }),
    }));
    expect(setup).toHaveBeenCalledWith("harry");
    expect(result.reEscrow).toBe("ok");
  });

  it("makeRotationReEscrow: enrolled + setup throws (WebAuthn cancelled) → 'failed'", async () => {
    const k = await loadKeystore();
    const { runRotateAdminRoot } = await loadRotation();
    const { makeRotationReEscrow } = await loadAccountSecurityView();
    const result = await runRotateAdminRoot(rotationDeps(k, {
      reEscrow: makeRotationReEscrow({
        hasCloudRecovery: vi.fn(async () => true),
        setupCloudRecovery: vi.fn(async () => { throw new Error("NotAllowedError"); }),
      }),
    }));
    expect(result.reEscrow).toBe("failed");
  });

  it("the view surfaces a failed re-escrow as a persistent warning (not just the toast)", async () => {
    const view = await loadAccountSecurityView();
    expect(view.ROTATE_REESCROW_FAILED_MESSAGE).toMatch(/recovery backup wasn't updated/);
    expect(view.ROTATE_REESCROW_FAILED_MESSAGE).toMatch(/OLD admin key/);
    // The rotate handler branches on the lib's returned status into
    // state.failureMessage (the persistent render), keeping the success
    // toast for the happy path.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      resolve(__dirname, "..", "public", "webapp", "views", "account-security.js"), "utf8");
    expect(src).toContain('result.reEscrow === "failed"');
    expect(src).toContain("state.failureMessage = ROTATE_REESCROW_FAILED_MESSAGE");
    expect(src).toContain("reEscrow: makeRotationReEscrow()");
  });
});

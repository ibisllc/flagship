/**
 * Unit tests for the device-capability-grants public + per-device
 * handlers (S3.3). Mirrors the pattern in the other control-plane tests
 * (pure handlers + InMemoryStorage; no network).
 *
 * Covered:
 *   - mint round-trip → list shows the grant
 *   - revoke → list excludes the grant
 *   - bad signature → 403
 *   - mismatched username → 400
 *   - requireDeviceScope: user-IRK fast path
 *   - requireDeviceScope: device-grant path with full coverage of every
 *     failure mode (no grant, expired, username mismatch, missing
 *     scope, signature corruption)
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceCapabilityGrant,
  signRevokeDeviceCapabilityGrant,
  type DeviceCapabilityGrant,
  type DeviceScope,
  type Keypair,
  type RevokeDeviceCapabilityGrant,
} from "@flagship/protocol";
import {
  InMemoryDeviceCapabilityGrantStorage,
  InMemoryDeviceIdentityStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleMintDeviceGrant,
  handleRevokeDeviceGrant,
  requireDeviceScope,
  type DeviceCapabilityGrantsDeps,
} from "../src/deviceCapabilityGrants.js";

const USER = "alice";
const DEVICE_A = "00112233445566778899aabbccddeeff";

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

interface Harness {
  deps: DeviceCapabilityGrantsDeps;
  userIrk: Keypair;
  clock: { now: number };
}

async function mkHarness(): Promise<Harness> {
  const userIrk = makeKey();
  const usernames = new InMemoryUsernameStorage();
  await usernames.put({
    username: USER,
    irkPubHex: hex(userIrk.publicKey),
    claimedAt: 1,
  });
  const storage = new InMemoryDeviceCapabilityGrantStorage();
  const clock = { now: 1_000_000 };
  const deps: DeviceCapabilityGrantsDeps = {
    storage,
    identities: new InMemoryDeviceIdentityStorage(),
    usernames,
    now: () => clock.now,
  };
  return { deps, userIrk, clock };
}

function mintGrant(args: {
  userIrk: Keypair;
  username?: string;
  deviceId?: string;
  devicePub?: Uint8Array;
  scopes?: DeviceScope[];
  issuedAt?: number;
  expiresAt?: number;
  grantId?: string;
}): {
  body: {
    grant: {
      grantId: string;
      username: string;
      deviceId: string;
      devicePubKey: string;
      scopes: DeviceScope[];
      issuedAt: number;
      expiresAt: number;
    };
    signature: string;
  };
  grant: DeviceCapabilityGrant;
  signature: Uint8Array;
} {
  const deviceId = args.deviceId ?? DEVICE_A;
  const devicePub = args.devicePub ?? makeKey().publicKey;
  const scopes = args.scopes ?? ["browse", "install-service"];
  const issuedAt = args.issuedAt ?? 1_000_000;
  const expiresAt = args.expiresAt ?? issuedAt + 90 * 24 * 3_600_000;
  const grantId = args.grantId ?? "0f8fad5b-d9cb-469f-a165-70867728950e";
  const grant: DeviceCapabilityGrant = {
    grantId,
    username: args.username ?? USER,
    deviceId,
    devicePubKey: devicePub,
    scopes,
    issuedAt,
    expiresAt,
  };
  const sig = signDeviceCapabilityGrant(grant, args.userIrk);
  return {
    body: {
      grant: {
        grantId,
        username: grant.username,
        deviceId,
        devicePubKey: hex(devicePub),
        scopes,
        issuedAt,
        expiresAt,
      },
      signature: hex(sig),
    },
    grant,
    signature: sig,
  };
}

// ──────────────────────────────────────────────────────────────────────
// handleMintDeviceGrant
// ──────────────────────────────────────────────────────────────────────

describe("handleMintDeviceGrant", () => {
  it("rejects malformed body", async () => {
    const h = await mkHarness();
    const r = await handleMintDeviceGrant(h.deps, undefined);
    expect(r.status).toBe(400);
  });

  it("rejects unknown username", async () => {
    const h = await mkHarness();
    const m = mintGrant({ userIrk: h.userIrk, username: "bob" });
    const r = await handleMintDeviceGrant(h.deps, m.body);
    expect(r.status).toBe(404);
  });

  it("rejects bad signature with 403", async () => {
    const h = await mkHarness();
    const m = mintGrant({ userIrk: h.userIrk });
    m.body.signature = hex(new Uint8Array(64));
    const r = await handleMintDeviceGrant(h.deps, m.body);
    expect(r.status).toBe(403);
  });

  it("rejects a grant id the relay log could not carry (its revocation would never reach the relays)", async () => {
    const h = await mkHarness();
    for (const grantId of ["grant-1", "zz", "-0a", "0".repeat(65), "0a_1"]) {
      const m = mintGrant({ userIrk: h.userIrk, grantId });
      expect((await handleMintDeviceGrant(h.deps, m.body)).status, grantId).toBe(400);
      expect(await h.deps.storage.get(grantId)).toBeUndefined();
    }
    // The apps' UUIDs, upper-case included, are fine.
    const ok = mintGrant({ userIrk: h.userIrk, grantId: "0F8FAD5B-D9CB-469F-A165-70867728950E" });
    expect((await handleMintDeviceGrant(h.deps, ok.body)).status).toBe(200);
  });

  it("rejects an expired grant with 400", async () => {
    const h = await mkHarness();
    const m = mintGrant({
      userIrk: h.userIrk,
      issuedAt: h.clock.now - 10_000,
      expiresAt: h.clock.now - 1_000,
    });
    const r = await handleMintDeviceGrant(h.deps, m.body);
    expect(r.status).toBe(400);
  });

  it("persists a valid grant and returns shape", async () => {
    const h = await mkHarness();
    const m = mintGrant({ userIrk: h.userIrk });
    const r = await handleMintDeviceGrant(h.deps, m.body);
    expect(r.status).toBe(200);
    const stored = await h.deps.storage.get(m.body.grant.grantId);
    expect(stored).toBeDefined();
    expect(stored!.revokedAt).toBeNull();
    expect(stored!.username).toBe(USER);
    expect(JSON.parse(stored!.scopesJson)).toEqual(m.body.grant.scopes);
  });

  it("cannot bind an existing immutable deviceId to another key", async () => {
    const h = await mkHarness();
    const a = mintGrant({ userIrk: h.userIrk, grantId: "0a-1" });
    expect((await handleMintDeviceGrant(h.deps, a.body)).status).toBe(200);
    const b = mintGrant({
      userIrk: h.userIrk,
      grantId: "0a-2",
      devicePub: makeKey().publicKey,
    });
    const r = await handleMintDeviceGrant(h.deps, b.body);
    expect(r.status).toBe(403);
  });

  // Live gym 2026-11-23 (choose-name): after a rename the device's admin grant sits under the new name with bytes
  // that name the old one; the apps mint a replacement for the same key, then revoke the old one.
  it("lets the admin root replace a device's grant for the same key; a member grant still can't double up", async () => {
    const h = await mkHarness();
    const adminRoot = makeKey();
    await h.deps.usernames.put({ username: USER, irkPubHex: hex(h.userIrk.publicKey), claimedAt: 1, adminRootPubHex: hex(adminRoot.publicKey) } as never);
    const deviceKey = makeKey().publicKey;
    const first = mintGrant({ userIrk: adminRoot, devicePub: deviceKey, scopes: ["admin", "browse"], grantId: "0a-1" });
    expect((await handleMintDeviceGrant(h.deps, first.body)).status).toBe(200);
    const second = mintGrant({ userIrk: adminRoot, devicePub: deviceKey, scopes: ["admin", "browse"], grantId: "0a-2" });
    expect((await handleMintDeviceGrant(h.deps, second.body)).status).toBe(200);
    expect((await h.deps.storage.get("0a-1"))!.revokedAt).not.toBeNull();
    expect((await h.deps.storage.get("0a-2"))!.revokedAt).toBeNull();
    const member = mintGrant({ userIrk: h.userIrk, devicePub: deviceKey, grantId: "0a-3" });
    expect((await handleMintDeviceGrant(h.deps, member.body)).status).toBe(409);
    expect((await h.deps.storage.get("0a-2"))!.revokedAt).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// handleRevokeDeviceGrant
// ──────────────────────────────────────────────────────────────────────

function revokeBody(args: {
  userIrk: Keypair;
  grantId: string;
  username?: string;
  reason?: "lost" | "stolen" | "decommissioned" | "replaced";
  issuedAt?: number;
}) {
  const envelope: RevokeDeviceCapabilityGrant = {
    grantId: args.grantId,
    username: args.username ?? USER,
    reason: args.reason ?? "lost",
    issuedAt: args.issuedAt ?? 1_000_000,
  };
  const sig = signRevokeDeviceCapabilityGrant(envelope, args.userIrk);
  return {
    request: {
      grantId: envelope.grantId,
      username: envelope.username,
      reason: envelope.reason,
      issuedAt: envelope.issuedAt,
    },
    signature: hex(sig),
  };
}

describe("handleRevokeDeviceGrant", () => {
  it("rejects malformed body", async () => {
    const h = await mkHarness();
    const r = await handleRevokeDeviceGrant(h.deps, undefined);
    expect(r.status).toBe(400);
  });

  it("404 on unknown grantId", async () => {
    const h = await mkHarness();
    const body = revokeBody({ userIrk: h.userIrk, grantId: "nope" });
    const r = await handleRevokeDeviceGrant(h.deps, body);
    expect(r.status).toBe(404);
  });

  it("400 when revocation username mismatches grant", async () => {
    const h = await mkHarness();
    // Seed a second user so the username-lookup step succeeds; the
    // grant→username mismatch is what we're pinning, not the
    // username-not-registered branch.
    await h.deps.usernames.put({
      username: "bob",
      irkPubHex: hex(makeKey().publicKey),
      claimedAt: 1,
    });
    const m = mintGrant({ userIrk: h.userIrk, grantId: "0a-1" });
    await handleMintDeviceGrant(h.deps, m.body);
    const body = revokeBody({
      userIrk: h.userIrk,
      grantId: "0a-1",
      username: "bob",
    });
    const r = await handleRevokeDeviceGrant(h.deps, body);
    expect(r.status).toBe(400);
  });

  it("403 on bad signature", async () => {
    const h = await mkHarness();
    const m = mintGrant({ userIrk: h.userIrk, grantId: "0a-1" });
    await handleMintDeviceGrant(h.deps, m.body);
    const body = revokeBody({ userIrk: h.userIrk, grantId: "0a-1" });
    body.signature = hex(new Uint8Array(64));
    const r = await handleRevokeDeviceGrant(h.deps, body);
    expect(r.status).toBe(403);
  });

  it("marks the grant revoked", async () => {
    const h = await mkHarness();
    const m = mintGrant({ userIrk: h.userIrk, grantId: "0a-1" });
    await handleMintDeviceGrant(h.deps, m.body);

    const body = revokeBody({ userIrk: h.userIrk, grantId: "0a-1" });
    const r = await handleRevokeDeviceGrant(h.deps, body);
    expect(r.status).toBe(200);
    expect((r.body as { revokedAt: number }).revokedAt).toBe(h.clock.now);

    expect((await h.deps.storage.get("0a-1"))?.revokedAt).toBe(h.clock.now);
  });
});

// ──────────────────────────────────────────────────────────────────────
// requireDeviceScope
// ──────────────────────────────────────────────────────────────────────

describe("requireDeviceScope", () => {
  it("does not treat the shared membership IRK as a device identity", async () => {
    const h = await mkHarness();
    const r = await requireDeviceScope(
      h.deps,
      hex(h.userIrk.publicKey),
      USER,
      "install-service",
    );
    expect(r).toEqual({ ok: false, reason: "no active device grant" });
  });

  it("rejects when username is not registered", async () => {
    const h = await mkHarness();
    const r = await requireDeviceScope(
      h.deps,
      hex(h.userIrk.publicKey),
      "ghost",
      "browse",
    );
    expect(r).toEqual({ ok: false, reason: "username not registered" });
  });

  it("rejects when the signer has no active grant", async () => {
    const h = await mkHarness();
    const stranger = makeKey();
    const r = await requireDeviceScope(
      h.deps,
      hex(stranger.publicKey),
      USER,
      "browse",
    );
    expect(r).toEqual({ ok: false, reason: "no active device grant" });
  });

  it("allows a device-grant signer when the requested scope is in coverage", async () => {
    const h = await mkHarness();
    const device = makeKey();
    const m = mintGrant({
      userIrk: h.userIrk,
      devicePub: device.publicKey,
      scopes: ["browse", "install-service"],
    });
    await handleMintDeviceGrant(h.deps, m.body);
    const r = await requireDeviceScope(
      h.deps,
      hex(device.publicKey),
      USER,
      "install-service",
    );
    expect(r).toEqual({ ok: true });
  });

  it("rejects a device-grant signer when the requested scope is NOT in coverage", async () => {
    const h = await mkHarness();
    const device = makeKey();
    const m = mintGrant({
      userIrk: h.userIrk,
      devicePub: device.publicKey,
      scopes: ["browse"],
    });
    await handleMintDeviceGrant(h.deps, m.body);
    const r = await requireDeviceScope(
      h.deps,
      hex(device.publicKey),
      USER,
      "install-service",
    );
    expect(r).toEqual({ ok: false, reason: "missing scope: install-service" });
  });

  it("rejects when the grant expired", async () => {
    const h = await mkHarness();
    const device = makeKey();
    const m = mintGrant({
      userIrk: h.userIrk,
      devicePub: device.publicKey,
      issuedAt: h.clock.now - 1000,
      expiresAt: h.clock.now + 5000,
    });
    await handleMintDeviceGrant(h.deps, m.body);
    h.clock.now += 10_000;
    const r = await requireDeviceScope(
      h.deps,
      hex(device.publicKey),
      USER,
      "browse",
    );
    expect(r).toEqual({ ok: false, reason: "grant expired" });
  });

  it("rejects when the grant's username doesn't match the caller's username", async () => {
    const h = await mkHarness();
    // Set up a second user with their own device grant; then ask the
    // first user's username with the second user's device pubkey.
    const bobIrk = makeKey();
    await h.deps.usernames.put({
      username: "bob",
      irkPubHex: hex(bobIrk.publicKey),
      claimedAt: 1,
    });
    const bobDevice = makeKey();
    // Mint a grant under bob's name for bobDevice.
    const m = mintGrant({
      userIrk: bobIrk,
      username: "bob",
      devicePub: bobDevice.publicKey,
      scopes: ["browse"],
    });
    await handleMintDeviceGrant(h.deps, m.body);
    const r = await requireDeviceScope(
      h.deps,
      hex(bobDevice.publicKey),
      USER, // wrong owner
      "browse",
    );
    expect(r).toEqual({ ok: false, reason: "device identity inactive" });
  });

  it("rejects when the grant signature fails defense-in-depth re-verification", async () => {
    const h = await mkHarness();
    const device = makeKey();
    const m = mintGrant({
      userIrk: h.userIrk,
      devicePub: device.publicKey,
    });
    await handleMintDeviceGrant(h.deps, m.body);
    // Corrupt the stored signature without going through the mint
    // path — simulates a D1 row that was tampered with after the fact.
    const stored = await h.deps.storage.get(m.body.grant.grantId);
    stored!.signatureHex = hex(new Uint8Array(64));
    // The InMemory adapter clones on read, so we have to re-insert
    // the corrupted row. Use revoke-then-put? Easier — directly poke
    // the internal map via put (the adapter accepts a re-put because
    // we revoke the prior active row first).
    await h.deps.storage.revoke(m.body.grant.grantId, h.clock.now);
    await h.deps.storage.put({
      ...stored!,
      revokedAt: null,
      issuedAt: stored!.issuedAt + 1, // distinct active grant
    });
    const r = await requireDeviceScope(
      h.deps,
      hex(device.publicKey),
      USER,
      "browse",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/signature/);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// task #39 — pin the KNOWN set of grant-authorization consumers.
//
// `requireDeviceScope` is the only function that turns a
// DeviceCapabilityGrant (and therefore its revocation) into an
// operationally meaningful authorization decision. It now has exactly ONE
// production consumer: `serverRevocation.ts` (the device-authorized
// server-revoke path — a 2nd device with the `revoke-others`/`admin`
// scope). That wiring is what makes `handleRevokeDeviceGrant` bite: a
// revoked grant immediately stops authorizing a revocation. The test below
// keeps its original spirit — it asserts the EXACT known-consumer set, so a
// NEW handler that starts authorizing via device grants without conscious
// review still fails the pin (forcing the author to either prove the
// revocation/expiry path is covered for the new consumer, or update this
// list).
// ──────────────────────────────────────────────────────────────────────

const KNOWN_REQUIRE_DEVICE_SCOPE_CONSUMERS = ["accountDirectory.ts", "serverRevocation.ts"];

describe("requireDeviceScope production consumers (grant-authorization pin)", () => {
  it("is called only by the known-consumer set of control-plane src/*.ts handlers", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    const here = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(here, "..", "src");

    const callers: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts")) continue;
      // The definition lives in deviceCapabilityGrants.ts — skip it; we
      // care about OTHER files invoking it.
      if (name === "deviceCapabilityGrants.ts") continue;
      const raw = readFileSync(join(srcDir, name), "utf8");
      // Strip line + block comments so prose that mentions the name
      // (e.g. "...verification at requireDeviceScope (defense-in-depth")
      // isn't mistaken for a call site.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      // A production CALL site looks like `requireDeviceScope(` — an
      // import or a comment mentioning the name does not.
      if (/\brequireDeviceScope\s*\(/.test(code)) {
        callers.push(name);
      }
    }

    // If this fails, the set of grant-authorizing handlers changed.
    // Either a new handler started authorizing via device grants (intended —
    // grants now bite there; add it to KNOWN_REQUIRE_DEVICE_SCOPE_CONSUMERS
    // and make sure handleRevokeDeviceGrant's effect is covered for that
    // path), or it's a half-wired hole. Do NOT just delete the assertion.
    expect(callers.sort()).toEqual(
      [...KNOWN_REQUIRE_DEVICE_SCOPE_CONSUMERS].sort(),
    );
  });
});

describe("account-key grants on an account that pins an admin root", () => {
  async function pinned(extra: { isDemo?: boolean } = {}) {
    const h = await mkHarness();
    const adminRoot = makeKey();
    await h.deps.usernames.put({ username: USER, irkPubHex: hex(h.userIrk.publicKey), adminRootPubHex: hex(adminRoot.publicKey), claimedAt: 1 });
    if (extra.isDemo) await h.deps.usernames.setDemo(USER, true);
    return { ...h, adminRoot };
  }

  it("the account key mints a member's scopes and nothing more", async () => {
    const h = await pinned();
    const member = mintGrant({ userIrk: h.userIrk, scopes: ["browse", "install-service", "vibe-code", "view-directory"] });
    expect((await handleMintDeviceGrant(h.deps, member.body)).status).toBe(200);
    for (const extra of ["revoke-others", "add-device", "manage-services", "demo-provision"] as const) {
      const m = mintGrant({ userIrk: h.userIrk, scopes: ["browse", extra], deviceId: "ab".repeat(16), grantId: `0b-${["revoke-others", "add-device", "manage-services", "demo-provision"].indexOf(extra)}` });
      const r = await handleMintDeviceGrant(h.deps, m.body);
      expect(r.status).toBe(403);
      expect((r.body as { code?: string }).code).toBe("admin-key-required");
    }
  });

  it("the admin root still mints an admin grant", async () => {
    const h = await pinned();
    const m = mintGrant({ userIrk: h.adminRoot, scopes: ["revoke-others", "admin"] });
    expect((await handleMintDeviceGrant(h.deps, m.body)).status).toBe(200);
  });

  it("a stored account-key grant gives no scope beyond a member's", async () => {
    const h = await pinned();
    const device = makeKey();
    const m = mintGrant({ userIrk: h.userIrk, devicePub: device.publicKey, scopes: ["browse", "revoke-others", "view-directory"] });
    // Written before this rule (or by a demo provision): only the read side applies.
    await h.deps.storage.put({
      grantId: m.grant.grantId, username: USER, deviceId: DEVICE_A, devicePubHex: hex(device.publicKey),
      scopesJson: JSON.stringify(m.grant.scopes), issuedAt: m.grant.issuedAt, expiresAt: m.grant.expiresAt,
      signatureHex: hex(m.signature), revokedAt: null, signerRoot: "membership",
    });
    await h.deps.identities.put({ accountId: USER, deviceId: DEVICE_A, devicePubHex: hex(device.publicKey), platformClass: null, createdAt: 1, lastSeenAt: 1, revokedAt: null });
    expect((await requireDeviceScope(h.deps, hex(device.publicKey), USER, "view-directory")).ok).toBe(true);
    expect((await requireDeviceScope(h.deps, hex(device.publicKey), USER, "revoke-others")).ok).toBe(false);
    await h.deps.usernames.setDemo(USER, true);
    expect((await requireDeviceScope(h.deps, hex(device.publicKey), USER, "revoke-others")).ok).toBe(true);
  });

  it("the account key can't revoke an admin grant, but the rename's revoke after the admin root's replacement passes", async () => {
    const h = await pinned();
    const device = makeKey();
    const first = mintGrant({ userIrk: h.adminRoot, devicePub: device.publicKey, scopes: ["admin"], grantId: "0c-1" });
    expect((await handleMintDeviceGrant(h.deps, first.body)).status).toBe(200);
    const refused = await handleRevokeDeviceGrant(h.deps, revokeBody({ userIrk: h.userIrk, grantId: "0c-1" }));
    expect(refused.status).toBe(403);
    expect((refused.body as { code?: string }).code).toBe("admin-key-required");
    expect((await h.deps.storage.get("0c-1"))?.revokedAt).toBeNull();
    // Another key is refused outright.
    expect((await handleRevokeDeviceGrant(h.deps, revokeBody({ userIrk: makeKey(), grantId: "0c-1" }))).status).toBe(403);

    // The apps' rename: the admin root mints the replacement for the same key (which retires the old grant), then
    // the account key revokes the old one.
    const second = mintGrant({ userIrk: h.adminRoot, devicePub: device.publicKey, scopes: ["admin"], grantId: "0c-2", issuedAt: 1_000_001 });
    expect((await handleMintDeviceGrant(h.deps, second.body)).status).toBe(200);
    expect((await handleRevokeDeviceGrant(h.deps, revokeBody({ userIrk: h.userIrk, grantId: "0c-1", reason: "replaced" }))).status).toBe(200);
    expect((await h.deps.storage.get("0c-2"))?.revokedAt).toBeNull();
  });

  it("the admin root revokes an admin grant", async () => {
    const h = await pinned();
    const m = mintGrant({ userIrk: h.adminRoot, scopes: ["admin"], grantId: "0e-1" });
    expect((await handleMintDeviceGrant(h.deps, m.body)).status).toBe(200);
    expect((await handleRevokeDeviceGrant(h.deps, revokeBody({ userIrk: h.adminRoot, grantId: "0e-1" }))).status).toBe(200);
    expect((await h.deps.storage.get("0e-1"))?.revokedAt).not.toBeNull();
  });

  it("the account key still revokes a member grant", async () => {
    const h = await pinned();
    const m = mintGrant({ userIrk: h.userIrk, grantId: "0d-1", scopes: ["browse", "view-directory"] });
    expect((await handleMintDeviceGrant(h.deps, m.body)).status).toBe(200);
    expect((await handleRevokeDeviceGrant(h.deps, revokeBody({ userIrk: h.userIrk, grantId: "0d-1" }))).status).toBe(200);
  });

  it("a demo account keeps the old rules", async () => {
    const h = await pinned({ isDemo: true });
    const m = mintGrant({ userIrk: h.userIrk, scopes: ["browse", "revoke-others"] });
    expect((await handleMintDeviceGrant(h.deps, m.body)).status).toBe(200);
  });
});

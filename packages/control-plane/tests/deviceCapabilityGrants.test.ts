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
  const grantId = args.grantId ?? "grant-uuid-1";
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
    const a = mintGrant({ userIrk: h.userIrk, grantId: "g-1" });
    expect((await handleMintDeviceGrant(h.deps, a.body)).status).toBe(200);
    const b = mintGrant({
      userIrk: h.userIrk,
      grantId: "g-2",
      devicePub: makeKey().publicKey,
    });
    const r = await handleMintDeviceGrant(h.deps, b.body);
    expect(r.status).toBe(403);
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
    const m = mintGrant({ userIrk: h.userIrk, grantId: "g-1" });
    await handleMintDeviceGrant(h.deps, m.body);
    const body = revokeBody({
      userIrk: h.userIrk,
      grantId: "g-1",
      username: "bob",
    });
    const r = await handleRevokeDeviceGrant(h.deps, body);
    expect(r.status).toBe(400);
  });

  it("403 on bad signature", async () => {
    const h = await mkHarness();
    const m = mintGrant({ userIrk: h.userIrk, grantId: "g-1" });
    await handleMintDeviceGrant(h.deps, m.body);
    const body = revokeBody({ userIrk: h.userIrk, grantId: "g-1" });
    body.signature = hex(new Uint8Array(64));
    const r = await handleRevokeDeviceGrant(h.deps, body);
    expect(r.status).toBe(403);
  });

  it("marks the grant revoked", async () => {
    const h = await mkHarness();
    const m = mintGrant({ userIrk: h.userIrk, grantId: "g-1" });
    await handleMintDeviceGrant(h.deps, m.body);

    const body = revokeBody({ userIrk: h.userIrk, grantId: "g-1" });
    const r = await handleRevokeDeviceGrant(h.deps, body);
    expect(r.status).toBe(200);
    expect((r.body as { revokedAt: number }).revokedAt).toBe(h.clock.now);

    expect((await h.deps.storage.get("g-1"))?.revokedAt).toBe(h.clock.now);
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

/**
 * DeviceCapabilityGrant envelope tests.
 *
 * The grant binds a per-device IRK to a user under a human-meaningful
 * label with explicit capability scopes (v2 device-addressing — see
 * docs/v2-device-addressing-and-real-ticket.md §2). Modeled on
 * ServiceGrant; tests mirror serviceGrant.test.ts in shape.
 */
import { describe, expect, it } from "vitest";
import {
  type DeviceCapabilityGrant,
  type DeviceScope,
  type RevokeDeviceCapabilityGrant,
  DEVICE_SCOPES,
  deviceCapabilityGrantAuthorizesScope,
  deviceCapabilityGrantId,
  signDeviceCapabilityGrant,
  signRevokeDeviceCapabilityGrant,
  verifyDeviceCapabilityGrant,
  verifyRevokeDeviceCapabilityGrant,
} from "../src/auth.js";
import { deriveIRK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(7) };
const otherUmk = { seed: new Uint8Array(32).fill(8) };

const FIXED_DEVICE_PUB = new Uint8Array(32);
for (let i = 0; i < 32; i++) FIXED_DEVICE_PUB[i] = (i * 3 + 11) & 0xff;

function baseGrant(overrides: Partial<DeviceCapabilityGrant> = {}): DeviceCapabilityGrant {
  return {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "trent",
    deviceLabel: "ipad",
    devicePubKey: FIXED_DEVICE_PUB,
    scopes: ["browse", "install-service"],
    issuedAt: 1_780_000_000_000,
    expiresAt: 1_787_776_000_000, // +90 days
    ...overrides,
  };
}

function baseRevoke(
  overrides: Partial<RevokeDeviceCapabilityGrant> = {},
): RevokeDeviceCapabilityGrant {
  return {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "trent",
    reason: "lost",
    issuedAt: 1_785_000_000_000,
    ...overrides,
  };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(digest));
}

describe("DeviceCapabilityGrant — sign + verify", () => {
  it("a valid grant verifies under the issuing IRK", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signDeviceCapabilityGrant(g, irk);
    expect(verifyDeviceCapabilityGrant(g, sig, irk.publicKey)).toBe(true);
  });

  it("verification fails with a different IRK pubkey", () => {
    const irk = deriveIRK(umk);
    const other = deriveIRK(otherUmk);
    const g = baseGrant();
    const sig = signDeviceCapabilityGrant(g, irk);
    expect(verifyDeviceCapabilityGrant(g, sig, other.publicKey)).toBe(false);
  });

  it("verification fails on any field tamper", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signDeviceCapabilityGrant(g, irk);
    const tampered: DeviceCapabilityGrant = { ...g, username: "wendy" };
    expect(verifyDeviceCapabilityGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("verification fails when the signature is mutated", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signDeviceCapabilityGrant(g, irk);
    const tamperedSig = new Uint8Array(sig);
    tamperedSig[0] = (tamperedSig[0]! ^ 0x01) & 0xff;
    expect(verifyDeviceCapabilityGrant(g, tamperedSig, irk.publicKey)).toBe(false);
  });

  it("verification fails when a scope is silently added", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant({ scopes: ["browse"] });
    const sig = signDeviceCapabilityGrant(g, irk);
    const tampered: DeviceCapabilityGrant = { ...g, scopes: ["browse", "revoke-others"] };
    expect(verifyDeviceCapabilityGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("identical grants produce identical canonical bytes (deterministic)", async () => {
    const a = await deviceCapabilityGrantId(baseGrant());
    const b = await deviceCapabilityGrantId(baseGrant());
    expect(a).toBe(b);
  });

  it("canonical bytes are order-independent on scopes (DEVICE_SCOPES index order, not alphabetical)", async () => {
    // DEVICE_SCOPES order = [browse, install-service, vibe-code, add-device, manage-services, revoke-others, demo-provision]
    // Alphabetical would put 'add-device' first; DEVICE_SCOPES-index puts 'browse' first.
    const all: DeviceScope[] = [...DEVICE_SCOPES];
    const reversed = [...all].reverse();
    const a = await deviceCapabilityGrantId(baseGrant({ scopes: all }));
    const b = await deviceCapabilityGrantId(baseGrant({ scopes: reversed }));
    const c = await deviceCapabilityGrantId(
      baseGrant({ scopes: ["revoke-others", "browse", "vibe-code", "manage-services", "add-device", "demo-provision", "install-service"] }),
    );
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("deviceCapabilityGrantId matches an independently-computed SHA-256 of the canonical bytes", async () => {
    const g = baseGrant({ scopes: ["install-service", "browse"] }); // unsorted on input
    const sortedScopes = "browse,install-service"; // DEVICE_SCOPES-index sort
    const expected = await sha256Hex(
      [
        "flagship/device-capability-grant/v1",
        g.grantId,
        g.username,
        g.deviceLabel,
        hex(g.devicePubKey),
        sortedScopes,
        g.issuedAt,
        g.expiresAt,
      ].join("|"),
    );
    expect(await deviceCapabilityGrantId(g)).toBe(expected);
  });
});

describe("DeviceCapabilityGrant — separator + control-char rejection (H1 hardening)", () => {
  it("rejects '|' in grantId at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceCapabilityGrant(baseGrant({ grantId: "5|50" }), irk)).toThrow(
      /separator/,
    );
  });

  it("rejects '|' in username at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceCapabilityGrant(baseGrant({ username: "ha|rry" }), irk)).toThrow(
      /separator/,
    );
  });

  it("rejects '|' in deviceLabel at sign time", () => {
    const irk = deriveIRK(umk);
    // The label regex would reject this BEFORE the separator check, so we
    // assert it throws — either separator or regex reason is acceptable.
    expect(() => signDeviceCapabilityGrant(baseGrant({ deviceLabel: "ip|ad" }), irk)).toThrow();
  });

  it("rejects newline in username at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceCapabilityGrant(baseGrant({ username: "harry\n" }), irk)).toThrow(
      /control char/,
    );
  });
});

describe("DeviceCapabilityGrant — well-formedness", () => {
  it("rejects expiresAt <= issuedAt", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signDeviceCapabilityGrant(
        baseGrant({ issuedAt: 2_000_000_000_000, expiresAt: 2_000_000_000_000 }),
        irk,
      ),
    ).toThrow(/expiresAt/);
  });

  it("rejects empty scopes", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceCapabilityGrant(baseGrant({ scopes: [] }), irk)).toThrow(/scopes/);
  });

  it("rejects unknown scope", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signDeviceCapabilityGrant(
        baseGrant({ scopes: ["browse", "nope" as unknown as DeviceScope] }),
        irk,
      ),
    ).toThrow(/unknown scope/);
  });

  it("rejects duplicate scope", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signDeviceCapabilityGrant(baseGrant({ scopes: ["browse", "browse"] }), irk),
    ).toThrow(/duplicate/);
  });

  it("rejects reserved deviceLabel", () => {
    const irk = deriveIRK(umk);
    for (const reserved of ["admin", "user", "root", "home", "service", "services"]) {
      expect(() =>
        signDeviceCapabilityGrant(baseGrant({ deviceLabel: reserved }), irk),
      ).toThrow(/reserved/);
    }
  });

  it("rejects leading-hyphen deviceLabel", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceCapabilityGrant(baseGrant({ deviceLabel: "-ipad" }), irk)).toThrow(
      /start or end/,
    );
  });

  it("rejects trailing-hyphen deviceLabel", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceCapabilityGrant(baseGrant({ deviceLabel: "ipad-" }), irk)).toThrow(
      /start or end/,
    );
  });

  it("rejects deviceLabel with disallowed chars", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceCapabilityGrant(baseGrant({ deviceLabel: "iPad" }), irk)).toThrow(
      /must match/,
    );
    expect(() => signDeviceCapabilityGrant(baseGrant({ deviceLabel: "ip ad" }), irk)).toThrow();
    expect(() => signDeviceCapabilityGrant(baseGrant({ deviceLabel: "" }), irk)).toThrow();
    expect(() =>
      signDeviceCapabilityGrant(baseGrant({ deviceLabel: "a".repeat(25) }), irk),
    ).toThrow();
  });

  it("rejects devicePubKey of wrong length", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signDeviceCapabilityGrant(baseGrant({ devicePubKey: new Uint8Array(31) }), irk),
    ).toThrow(/32 bytes/);
  });
});

describe("DeviceCapabilityGrant — query helper", () => {
  it("deviceCapabilityGrantAuthorizesScope returns true for a scope in the list", () => {
    const g = baseGrant({ scopes: ["browse", "install-service"] });
    expect(deviceCapabilityGrantAuthorizesScope(g, "browse")).toBe(true);
    expect(deviceCapabilityGrantAuthorizesScope(g, "install-service")).toBe(true);
  });

  it("deviceCapabilityGrantAuthorizesScope returns false for a scope NOT in the list", () => {
    const g = baseGrant({ scopes: ["browse"] });
    expect(deviceCapabilityGrantAuthorizesScope(g, "install-service")).toBe(false);
    expect(deviceCapabilityGrantAuthorizesScope(g, "revoke-others")).toBe(false);
  });
});

describe("RevokeDeviceCapabilityGrant — sign + verify", () => {
  it("a valid revoke envelope verifies under the issuing IRK", () => {
    const irk = deriveIRK(umk);
    const r = baseRevoke();
    const sig = signRevokeDeviceCapabilityGrant(r, irk);
    expect(verifyRevokeDeviceCapabilityGrant(r, sig, irk.publicKey)).toBe(true);
  });

  it("verification fails with a different IRK pubkey", () => {
    const irk = deriveIRK(umk);
    const other = deriveIRK(otherUmk);
    const r = baseRevoke();
    const sig = signRevokeDeviceCapabilityGrant(r, irk);
    expect(verifyRevokeDeviceCapabilityGrant(r, sig, other.publicKey)).toBe(false);
  });

  it("verification fails on any field tamper", () => {
    const irk = deriveIRK(umk);
    const r = baseRevoke();
    const sig = signRevokeDeviceCapabilityGrant(r, irk);
    const tampered: RevokeDeviceCapabilityGrant = { ...r, reason: "stolen" };
    expect(verifyRevokeDeviceCapabilityGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("verification fails when the signature is mutated", () => {
    const irk = deriveIRK(umk);
    const r = baseRevoke();
    const sig = signRevokeDeviceCapabilityGrant(r, irk);
    const tamperedSig = new Uint8Array(sig);
    tamperedSig[0] = (tamperedSig[0]! ^ 0x01) & 0xff;
    expect(verifyRevokeDeviceCapabilityGrant(r, tamperedSig, irk.publicKey)).toBe(false);
  });

  it("accepts every valid reason in the enum", () => {
    const irk = deriveIRK(umk);
    for (const reason of ["lost", "stolen", "decommissioned", "replaced"] as const) {
      const r = baseRevoke({ reason });
      const sig = signRevokeDeviceCapabilityGrant(r, irk);
      expect(verifyRevokeDeviceCapabilityGrant(r, sig, irk.publicKey)).toBe(true);
    }
  });

  it("rejects an unknown reason", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signRevokeDeviceCapabilityGrant(
        baseRevoke({ reason: "nope" as unknown as "lost" }),
        irk,
      ),
    ).toThrow(/unknown reason/);
  });

  it("rejects '|' in grantId", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signRevokeDeviceCapabilityGrant(baseRevoke({ grantId: "5|50" }), irk),
    ).toThrow(/separator/);
  });

  it("rejects control char in username", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signRevokeDeviceCapabilityGrant(baseRevoke({ username: "harry\n" }), irk),
    ).toThrow(/control char/);
  });
});

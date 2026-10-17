// Builds test-vectors/device-pairing/vectors.json: adding a device to an
// account over the pairing relay (admin devices only, owner rule 2026-10-16).
// Regenerate with:  npx tsx packages/protocol/tests/genDevicePairingVectors.ts
// Inputs are fixed and Ed25519 is deterministic, so the output is byte-stable;
// devicePairingVectors.test.ts fails when the file drifts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { ed } from "../src/edSync.js";
import { signDeviceAdmit } from "../src/push.js";
import { DEVICE_SCOPES, signDeviceCapabilityGrant, type DeviceCapabilityGrant } from "../src/deviceCapability.js";

const fill = (b: number) => new Uint8Array(32).fill(b);
const kp = (seed: Uint8Array) => ({ privateKey: seed, publicKey: ed.getPublicKey(seed) });

export const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-vectors/device-pairing/vectors.json",
);

export const MEMBER_DEVICE_SCOPES = ["browse", "install-service", "vibe-code", "view-directory"] as const;
export const DEVICE_GRANT_TTL_MS = 90 * 24 * 3_600_000;

export function buildDevicePairingVectors(): unknown {
  const irk = kp(fill(0x11));
  const admin = kp(fill(0x22));
  const device = kp(fill(0x44));
  const deviceId = "10".repeat(16);
  const username = "harry";
  const issuedAt = 1_760_000_000_000;
  const admit = { username, deviceId, newDevicePubHex: bytesToHex(device.publicKey), issuedAt };
  const admitSigHex = bytesToHex(signDeviceAdmit(admit, irk));

  const grantFor = (grantId: string, scopes: readonly string[], signer: ReturnType<typeof kp>, signerRoot: string) => {
    const g = {
      grantId, username, deviceId, devicePubKey: device.publicKey,
      scopes: scopes as DeviceCapabilityGrant["scopes"], issuedAt, expiresAt: issuedAt + DEVICE_GRANT_TTL_MS,
    };
    const sorted = [...scopes].sort((a, b) => DEVICE_SCOPES.indexOf(a as never) - DEVICE_SCOPES.indexOf(b as never));
    return {
      grant: {
        grantId, username, deviceId, devicePubHex: bytesToHex(device.publicKey), scopes: sorted,
        issuedAt: g.issuedAt, expiresAt: g.expiresAt, signerRoot,
      },
      canonical: [
        "flagship/device-capability-grant/v2", grantId, username, deviceId, bytesToHex(device.publicKey),
        sorted.join(","), g.issuedAt, g.expiresAt,
      ].join("|"),
      signatureHex: bytesToHex(signDeviceCapabilityGrant(g, signer)),
    };
  };

  return {
    about:
      "Adding a device over the pairing relay (owner rule 2026-10-16: admin devices only; a device without the admin root shows the line in `adminOnlyLine` and never opens a code). The admin device vouches with a flagship/device-admit/v2 admit signed by the account key (IRK), and signs a device grant for the new device's key: a MEMBER grant (memberScopes, signerRoot 'membership', signed by the IRK) or, when it promotes the device to admin, an admin grant (every scope, signerRoot 'admin-root', signed by the admin root, whose seed also rides in `wrappedAdminRoot`). The sealed relay bundle is JSON with exactly the keys in `bundleKeys`; the joining device checks the admit and the grant, signs its encrypted name (flagship/device-profile-self/v1) with its own key, and POSTs /api/users/<u>/devices/admit with exactly the keys in `postKeys`; .com answers 400 'missing device bootstrap' without grant, grantSignature and profile. Grants last 90 days. Scopes sort by their index in DEVICE_SCOPES (scopeOrder), not alphabetically. Seeds are raw Ed25519 seeds.",
    adminOnlyLine: "Only an admin device of this account can add devices.",
    keys: {
      irkSeedHex: bytesToHex(fill(0x11)), irkPubHex: bytesToHex(irk.publicKey),
      adminRootSeedHex: bytesToHex(fill(0x22)), adminRootPubHex: bytesToHex(admin.publicKey),
      deviceSeedHex: bytesToHex(fill(0x44)), devicePubHex: bytesToHex(device.publicKey),
    },
    scopeOrder: [...DEVICE_SCOPES],
    memberScopes: [...MEMBER_DEVICE_SCOPES],
    grantTtlMs: DEVICE_GRANT_TTL_MS,
    bundleKeys: ["umkSeedHex", "admit", "admitSig", "irkPubHex", "grant", "grantSignature", "wrappedAdminRoot?"],
    postKeys: ["admit", "admitSig", "grant", "grantSignature", "profile", "request", "signature"],
    admit: {
      fields: admit,
      canonical: ["flagship/device-admit/v2", username, deviceId, admit.newDevicePubHex, issuedAt].join("|"),
      signatureHex: admitSigHex,
    },
    memberGrant: grantFor("0a0b0c0d-0e0f-4a1b-8c2d-3e4f50617283", MEMBER_DEVICE_SCOPES, irk, "membership"),
    adminGrant: grantFor("1a1b1c1d-1e1f-4a1b-8c2d-3e4f50617283", DEVICE_SCOPES, admin, "admin-root"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, JSON.stringify(buildDevicePairingVectors(), null, 2) + "\n");
}

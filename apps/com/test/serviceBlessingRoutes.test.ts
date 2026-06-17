/**
 * Route-wiring tests for the maintainer-trust enforcement endpoints
 * (docs/maintainer-trust-enforcement.md): the relay-blessing issuer and
 * the per-cert TrustException sync. Targets `tryControlPlane` with a stub
 * D1 binding — verifying dispatch + status codes. Deep functional coverage
 * lives in packages/control-plane/tests/serviceBlessing.test.ts.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import type { D1Database } from "@flagship/storage";
import {
  signTrustException,
  relayCertHash,
  deriveIRK,
  verifyCaSignedServiceBlessing,
  type CaTrustChain,
  type ServiceBlessing,
} from "@flagship/protocol";

function stubDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ success: true, meta: {} }),
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}
function env(): ControlPlaneEnv {
  return { DB: stubDb() };
}
const ORIGIN = "https://flagshipserver.com";

describe("POST /api/services/hub-blessing — dispatch", () => {
  it("mints a ServiceBlessing signed by the env CA key", async () => {
    const r = await tryControlPlane(
      new Request(`${ORIGIN}/api/services/hub-blessing`, {
        method: "POST",
        body: JSON.stringify({
          hubKeyPub: "ab".repeat(32),
          hubHost: "flagship.services",
        }),
      }),
      env(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    const body = (await r!.json()) as { blessing: ServiceBlessing };
    expect(body.blessing.kind).toBe("ServiceBlessing");
    expect(body.blessing.hubKeyPub).toBe("ab".repeat(32));
    // The dev CA key (caKeypairFromEnv default) signed it; verify the
    // blessing verifies through a chain authorizing that served key.
    const chain: CaTrustChain = {
      authorizedCaKeys: () => [body.blessing.signedBy],
    };
    expect(
      verifyCaSignedServiceBlessing(body.blessing, chain, Date.now(), "f".repeat(64)),
    ).toEqual({ ok: true });
  });

  it("400 on a malformed body", async () => {
    const r = await tryControlPlane(
      new Request(`${ORIGIN}/api/services/hub-blessing`, {
        method: "POST",
        body: JSON.stringify({ hubKeyPub: "nothex" }),
      }),
      env(),
    );
    expect(r!.status).toBe(400);
  });
});

describe("trust-exception sync routes — dispatch", () => {
  const device = deriveIRK({ seed: new Uint8Array(32).fill(0x11) });
  const certHash = relayCertHash("cd".repeat(32));
  const exc = signTrustException(
    { certClass: "relay", certHash, grantedAt: Date.now() },
    device,
  );

  it("POST stores a signature-valid exception → 200", async () => {
    const r = await tryControlPlane(
      new Request(`${ORIGIN}/api/users/alice/trust-exceptions`, {
        method: "POST",
        body: JSON.stringify(exc),
      }),
      env(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
  });

  it("POST a malformed exception → 400", async () => {
    const r = await tryControlPlane(
      new Request(`${ORIGIN}/api/users/alice/trust-exceptions`, {
        method: "POST",
        body: JSON.stringify({ kind: "nope" }),
      }),
      env(),
    );
    expect(r!.status).toBe(400);
  });

  it("GET lists exceptions → 200 (empty against the stub DB)", async () => {
    const r = await tryControlPlane(
      new Request(`${ORIGIN}/api/users/alice/trust-exceptions`, {
        method: "GET",
      }),
      env(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    const body = (await r!.json()) as { exceptions: unknown[] };
    expect(body.exceptions).toEqual([]);
  });
});

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
function env(extra: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv {
  return { DB: stubDb(), SERVICES_CONTROL_SECRET: SECRET, ...extra };
}
const ORIGIN = "https://flagshipserver.com";
const SECRET = "services-control-secret";

function blessingRequest(body: unknown, authorization?: string): Request {
  return new Request(`${ORIGIN}/api/services/hub-blessing`, {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  });
}

describe("POST /api/services/hub-blessing — dispatch", () => {
  const hub = { hubKeyPub: "ab".repeat(32), hubHost: "flagship.services" };

  it("mints a ServiceBlessing signed by the env CA key for the authenticated hub", async () => {
    const r = await tryControlPlane(blessingRequest(hub, `Bearer ${SECRET}`), env());
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

  it("401 for an anonymous caller (the reported signing-oracle request)", async () => {
    const r = await tryControlPlane(
      blessingRequest({ hubKeyPub: "d7".repeat(32), hubHost: "probe-verify.invalid" }),
      env(),
    );
    expect(r!.status).toBe(401);
    expect(await r!.json()).not.toHaveProperty("blessing");
  });

  it("401 for a wrong bearer secret", async () => {
    const r = await tryControlPlane(blessingRequest(hub, "Bearer nope"), env());
    expect(r!.status).toBe(401);
  });

  it("503 when SERVICES_CONTROL_SECRET is unset (fails closed)", async () => {
    const r = await tryControlPlane(
      blessingRequest(hub, `Bearer ${SECRET}`),
      env({ SERVICES_CONTROL_SECRET: undefined }),
    );
    expect(r!.status).toBe(503);
  });

  it("403 for a hubHost other than the services apex, even when authenticated", async () => {
    const r = await tryControlPlane(
      blessingRequest({ ...hub, hubHost: "probe-verify.invalid" }, `Bearer ${SECRET}`),
      env(),
    );
    expect(r!.status).toBe(403);
  });

  it("allows the configured SERVICES_APEX (the gym env) and only that", async () => {
    const gym = env({ SERVICES_APEX: "gym.flagship.services" });
    const ok = await tryControlPlane(
      blessingRequest({ ...hub, hubHost: "gym.flagship.services" }, `Bearer ${SECRET}`),
      gym,
    );
    expect(ok!.status).toBe(200);
    const prodHost = await tryControlPlane(blessingRequest(hub, `Bearer ${SECRET}`), gym);
    expect(prodHost!.status).toBe(403);
  });

  it("400 on a malformed body", async () => {
    const r = await tryControlPlane(
      blessingRequest({ hubKeyPub: "nothex" }, `Bearer ${SECRET}`),
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

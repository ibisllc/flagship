/**
 * The shared access-decision contract (packages/protocol/test-vectors/access-enforcement/decisions.json) run
 * through the real TypeScript path at the effect boundary: the access state file loaded by `ServiceAccessStore`,
 * the member session resolved by `buildAppSessionResolver`, and the proxy's decision and injected identity from
 * `prepareAppRequest`. rust/crates/flagship-access/tests/decision_vectors.rs runs the same cases.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Principal, PrincipalResolver } from "../src/accessPrincipals.js";
import { buildAppSessionResolver } from "../src/appMemberSession.js";
import type { ApiKeyAuth, ApiKeyAuthenticator } from "../src/appApiKeys.js";
import type { BoxSigner } from "../src/keyCustodian.js";
import { ServiceAccessStore } from "../src/serviceAccess.js";
import { prepareAppRequest } from "../src/serviceProxy.js";
import type { InstalledService } from "../src/servicePlatform.js";

const FILE = new URL("../../protocol/test-vectors/access-enforcement/decisions.json", import.meta.url);
const V = JSON.parse(readFileSync(FILE, "utf8")) as {
  fixtures: Record<string, Fixture>;
  cases: Case[];
};

interface Fixture {
  ownerAid: string;
  principals: Array<{ kind: "device"; pub: string; tier: "admin" | "member" } | { kind: "co-manager"; pub: string; shareId: string; level: "view" | "manage" }>;
  stateText: string | null;
}
interface Case {
  name: string;
  fixture: string;
  catchingUp?: string[];
  app: { serviceRef: string; host: string; publicRoutes: string[]; defaultRole: string };
  request: {
    method: string;
    path: string;
    upgrade: boolean;
    host?: string;
    headers: Record<string, string>;
    session: { serviceRef: string; aid: string; live: boolean } | null;
    apiKey: "none" | "invalid" | "scope" | "rate-limited" | { keyId: string; scope: "read" | "write" };
    externalFresh: boolean;
  };
  expect: { outcome: string; visitor?: string; role?: string | null; identity?: string | null; external?: boolean };
}

function resolver(f: Fixture): PrincipalResolver {
  const all: Principal[] = f.principals.map((p) =>
    p.kind === "device"
      ? { kind: "device", pub: p.pub, deviceId: null, tier: p.tier, legacy: false }
      : { kind: "co-manager", pub: p.pub, shareId: p.shareId, label: "", level: p.level },
  );
  return {
    classify: (pub) => all.find((p) => p.pub === pub.toLowerCase()) ?? null,
    ensure: async () => {},
    devices: () => all.filter((p): p is Extract<Principal, { kind: "device" }> => p.kind === "device"),
    coManagers: () => all.filter((p): p is Extract<Principal, { kind: "co-manager" }> => p.kind === "co-manager"),
    ownerAidHex: () => f.ownerAid,
  };
}

async function storeFor(name: string): Promise<ServiceAccessStore> {
  const f = V.fixtures[name]!;
  const dir = mkdtempSync(join(tmpdir(), "access-vec-"));
  const path = join(dir, "service-access.json");
  if (f.stateText !== null) writeFileSync(path, f.stateText);
  const s = new ServiceAccessStore(path, { ownerAidHex: f.ownerAid, principals: resolver(f) });
  await s.load();
  return s;
}

const signer: BoxSigner = {
  boxPublicKey: () => new Uint8Array(32),
  signAsBox: () => new Uint8Array(64),
  unsealToBox: () => new Uint8Array(),
  unsealPairingOrder: () => new Uint8Array(),
} as unknown as BoxSigner;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function tsDecision(c: Case): Promise<Omit<Case["expect"], "external">> {
  const store = await storeFor(c.fixture);
  for (const ref of c.catchingUp ?? []) store.setCatchingUp(ref, true);
  const app = {
    serviceId: c.app.serviceRef,
    urlLabel: c.app.host.split(".")[0]!,
    manifest: { name: "App", access: { enabled: true, default_role: c.app.defaultRole, public_routes: c.app.publicRoutes } },
    membership: { stableIdFor: (k: Uint8Array) => hex(k) },
  } as unknown as InstalledService;
  const r = c.request;
  const token = r.session ? "tok" : null;
  const sessions = {
    lookup: (t: string) => (t === token && r.session?.live ? { serviceRef: r.session.serviceRef, aid: r.session.aid } : null),
  };
  const apiKeys: ApiKeyAuthenticator = {
    authenticate: (): ApiKeyAuth =>
      (r.apiKey === "none"
        ? { kind: "none" }
        : r.apiKey === "invalid"
          ? { kind: "invalid" }
          : r.apiKey === "scope"
            ? { kind: "scope" }
            : r.apiKey === "rate-limited"
              ? { kind: "rate-limited", retryAfterSec: 1 }
              : { kind: "ok", keyId: r.apiKey.keyId, scope: r.apiKey.scope }) as ApiKeyAuth,
  };
  const headers: Record<string, string> = { host: r.host ?? c.app.host, ...r.headers };
  if (token) headers.cookie = `Flagship-App-Session=${token}`;
  const p = await prepareAppRequest(
    app,
    { method: r.method, path: r.path, headers, body: Buffer.alloc(0) } as never,
    {
      injector: signer,
      apiKeys,
      resolveSession: buildAppSessionResolver({ sessions, access: store }),
      externalFresh: () => r.externalFresh,
      accessMode: (id) => (store.mode(id) === "open" ? "open" : "members-only"),
    },
    { upgrade: r.upgrade, routedHost: c.app.host },
  );
  if (p.kind === "respond") {
    const s = p.response.status;
    return { outcome: s === 401 ? "api-invalid" : s === 403 && r.apiKey === "scope" ? "api-scope" : s === 429 ? "api-rate-limited" : "deny" };
  }
  const visitor = p.headers["x-flagship-visitor"]!;
  const user = p.headers["x-flagship-user"] ?? null;
  return {
    outcome: "forward",
    visitor,
    role: p.headers["x-flagship-role"] ?? null,
    identity: user,
  };
}

describe("access-enforcement decision vectors (TypeScript)", () => {
  it("has the cases the contract promises", () => {
    expect(V.cases.length).toBeGreaterThanOrEqual(90);
    expect(new Set(V.cases.map((c) => c.name)).size).toBe(V.cases.length);
  });
  for (const c of V.cases) {
    it(c.name, async () => {
      const got = await tsDecision(c);
      const { external: _external, ...want } = c.expect;
      expect(got).toEqual(want);
    });
  }
  it("external is what the session resolver reports", async () => {
    // The proxy does not put `external` on the wire, so check the resolver's own flag for every member case.
    for (const c of V.cases.filter((x) => x.expect.visitor === "member")) {
      const store = await storeFor(c.fixture);
      for (const ref of c.catchingUp ?? []) store.setCatchingUp(ref, true);
      const res = buildAppSessionResolver({
        sessions: { lookup: () => ({ serviceRef: c.request.session!.serviceRef, aid: c.request.session!.aid }) },
        access: store,
      });
      const s = res(
        { method: "GET", path: "/", headers: { cookie: "Flagship-App-Session=t" }, body: Buffer.alloc(0) } as never,
        { serviceId: c.app.serviceRef, manifest: { access: { default_role: c.app.defaultRole } }, membership: { stableIdFor: (k: Uint8Array) => hex(k) } } as never,
      );
      expect(s?.external === true, c.name).toBe(c.expect.external === true);
    }
  });
});

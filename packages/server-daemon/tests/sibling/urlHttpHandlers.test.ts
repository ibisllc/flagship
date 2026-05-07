import { describe, expect, it } from "vitest";
import {
  ed,
  signClaimUrlCapability,
  type ClaimUrlCapability,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryAppAuthTokens } from "../../src/appAuthToken.js";
import {
  admitCapability,
  InMemoryCapabilityStore,
  type RevocationCache,
} from "../../src/capabilityStore.js";
import { buildUrlHttpHandlers } from "../../src/sibling/urlHttpHandlers.js";
import type { UrlController } from "../../src/runtime.js";
import type { HttpRequest } from "../../src/runtime.js";

const POD = "home.alice.flagship.services";
const APP_A = "alice--notes";
const APP_B = "alice--tasks";

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

function inMemoryUrlController(): UrlController & { _list: Set<string> } {
  const set = new Set<string>();
  return {
    _list: set,
    async claim(f: string) {
      set.add(f.toLowerCase());
    },
    async release(f: string) {
      set.delete(f.toLowerCase());
    },
    list(): string[] {
      return [...set];
    },
  };
}

const noRevoke: RevocationCache = {
  has: async () => false,
  refresh: async () => {},
};

async function depositCap(
  store: InMemoryCapabilityStore,
  irk: Keypair,
  cap: ClaimUrlCapability,
  now = () => 1_500,
) {
  const sig = signClaimUrlCapability(cap, irk);
  return admitCapability({
    capability: cap,
    signatureHex: hex(sig),
    irkPubLookup: async () => irk.publicKey,
    store,
    now,
  });
}

async function setup() {
  const tokens = new InMemoryAppAuthTokens();
  const tokenA = await tokens.mint(APP_A);
  const tokenB = await tokens.mint(APP_B);
  const capStore = new InMemoryCapabilityStore();
  const ctrl = inMemoryUrlController();
  const irk = makeKey();
  const handle = buildUrlHttpHandlers({
    appAuthTokens: tokens,
    capabilityStore: capStore,
    revocations: noRevoke,
    urlController: ctrl,
    thisSiblingId: POD,
    canonicalFqdnsForApp: (appId) => {
      if (appId === APP_A) return [`notes.${POD}`];
      if (appId === APP_B) return [`tasks.${POD}`];
      return [];
    },
    now: () => 2_000,
  });
  return { tokens, tokenA, tokenB, capStore, ctrl, handle, irk };
}

function req(opts: {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}): HttpRequest {
  return {
    method: opts.method,
    path: opts.path,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: Buffer.from(opts.body !== undefined ? JSON.stringify(opts.body) : ""),
  };
}

describe("/api/url/claim", () => {
  it("admits a request with a valid (appId, siblingId, fqdn) capability", async () => {
    const s = await setup();
    await depositCap(s.capStore, s.irk, {
      username: "alice",
      appId: APP_A,
      siblingId: POD,
      fqdn: "notes.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/claim",
        token: s.tokenA,
        body: { fqdn: "notes.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(s.ctrl._list.has("notes.alice.flagship.services")).toBe(true);
  });

  it("REJECTS app B trying to claim with app A's stored cap (cross-app)", async () => {
    const s = await setup();
    await depositCap(s.capStore, s.irk, {
      username: "alice",
      appId: APP_A,
      siblingId: POD,
      fqdn: "notes.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/claim",
        token: s.tokenB, // app B's token
        body: { fqdn: "notes.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(403);
    expect(s.ctrl._list.size).toBe(0);
  });

  it("REJECTS a request whose fqdn doesn't match any stored cap", async () => {
    const s = await setup();
    await depositCap(s.capStore, s.irk, {
      username: "alice",
      appId: APP_A,
      siblingId: POD,
      fqdn: "notes.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/claim",
        token: s.tokenA,
        body: { fqdn: "tasks.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(403);
  });

  it("REJECTS attempts to claim canonical URLs", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/claim",
        token: s.tokenA,
        body: { fqdn: POD },
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("rejects malformed body", async () => {
    const s = await setup();
    const r = await s.handle(
      req({ method: "POST", path: "/api/url/claim", token: s.tokenA, body: { wrong: "shape" } }),
    );
    expect(r?.status).toBe(400);
  });
});

describe("/api/url/release", () => {
  it("releases a previously-claimed URL when the cap is still valid", async () => {
    const s = await setup();
    await depositCap(s.capStore, s.irk, {
      username: "alice",
      appId: APP_A,
      siblingId: POD,
      fqdn: "notes.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    await s.ctrl.claim("notes.alice.flagship.services");
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/release",
        token: s.tokenA,
        body: { fqdn: "notes.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(s.ctrl._list.size).toBe(0);
  });

  it("rejects release for an fqdn the calling app has no cap for (probe defense)", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/release",
        token: s.tokenA,
        body: { fqdn: "tasks.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(403);
  });
});

describe("/api/url and /api/url/owned", () => {
  it("/api/url lists canonical + capability-bearing FQDNs with ownedBy", async () => {
    const s = await setup();
    await depositCap(s.capStore, s.irk, {
      username: "alice",
      appId: APP_A,
      siblingId: POD,
      fqdn: "notes.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    await s.ctrl.claim("notes.alice.flagship.services");
    const r = await s.handle(req({ method: "GET", path: "/api/url", token: s.tokenA }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body)) as {
      urls: Array<{ fqdn: string; kind: string; ownedBy: string | null; canClaim: boolean }>;
    };
    const byFqdn = Object.fromEntries(body.urls.map((u) => [u.fqdn, u]));
    expect(byFqdn[`notes.${POD}`]).toMatchObject({
      kind: "canonical",
      ownedBy: "self",
      canClaim: false,
    });
    expect(byFqdn["notes.alice.flagship.services"]).toMatchObject({
      kind: "alias",
      ownedBy: "self",
      canClaim: true,
    });
  });

  it("/api/url omits another app's caps", async () => {
    const s = await setup();
    await depositCap(s.capStore, s.irk, {
      username: "alice",
      appId: APP_A,
      siblingId: POD,
      fqdn: "notes.alice.flagship.services",
      issuedAt: 1_000,
      expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    });
    const r = await s.handle(req({ method: "GET", path: "/api/url", token: s.tokenB }));
    const body = JSON.parse(String(r!.body)) as { urls: Array<{ fqdn: string }> };
    const fqdns = body.urls.map((u) => u.fqdn);
    expect(fqdns).not.toContain("notes.alice.flagship.services");
    // app B still sees its own canonical
    expect(fqdns).toContain(`tasks.${POD}`);
  });

  it("/api/url/owned reflects current urlController state", async () => {
    const s = await setup();
    await s.ctrl.claim("notes.alice.flagship.services");
    await s.ctrl.claim("custom.example");
    const r = await s.handle(req({ method: "GET", path: "/api/url/owned", token: s.tokenA }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body)) as { owned: Array<{ fqdn: string }> };
    expect(body.owned.map((x) => x.fqdn).sort()).toEqual(
      ["custom.example", "notes.alice.flagship.services"].sort(),
    );
  });
});

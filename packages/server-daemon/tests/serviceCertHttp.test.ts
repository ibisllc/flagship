import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ed,
  signServiceCertAuthority,
  signServiceCertExport,
  signServiceCertInstall,
  signServiceCertMint,
  type Keypair,
  type ServiceCertAuthority,
  type ServiceCertExportRequest,
  type ServiceCertInstall,
  type ServiceCertMintRequest,
} from "@flagship/protocol";
import { sha256 } from "@noble/hashes/sha256";
import { buildAlpnChallengeCert } from "../src/acme/alpnChallengeCert.js";
import {
  LetsEncryptIssuer,
  type AcmeAuthorization,
  type AcmeChallenge,
  type AcmeOrder,
  type DnsChallengeWriter,
  type MinimalAcmeClient,
} from "../src/acme/letsEncryptIssuer.js";
import { PersistentAcmeStore } from "../src/acme/persistentStore.js";
import { RemoteDnsChallengeWriter } from "../src/acme/remoteDnsChallengeWriter.js";
import { CertManager } from "../src/certManager.js";
import {
  buildServiceCertHandlers,
  rehydrateServiceCerts,
  type ServiceCertHttpDeps,
  type ServiceCertIssuer,
} from "../src/serviceCertHttp.js";
import type { HttpRequest, HttpResponse } from "../src/runtime.js";

const SERVER_FQDN = "abc5.harry1.flagship.services";
const USERNAME = "harry1";
const SERVICE_FQDN = "photos.harry1.flagship.services";
const NOW = 1_770_000_000_000;

function kp(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const IRK = kp(7);
const WRONG_IRK = kp(9);

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function post(path: string, body: unknown): HttpRequest {
  return { method: "POST", path, headers: {}, body: Buffer.from(JSON.stringify(body)) };
}

function json(r: HttpResponse): Record<string, unknown> {
  return JSON.parse(typeof r.body === "string" ? r.body : r.body.toString("utf8"));
}

function makeAuthority(overrides?: Partial<ServiceCertAuthority>): ServiceCertAuthority {
  return {
    username: USERNAME,
    serviceFqdn: SERVICE_FQDN,
    boxServerId: SERVER_FQDN,
    issuedAt: NOW - 60_000,
    expiresAt: NOW + 30 * 60_000,
    ...overrides,
  };
}

function makeMint(overrides?: Partial<ServiceCertMintRequest>): ServiceCertMintRequest {
  return {
    username: USERNAME,
    serviceFqdn: SERVICE_FQDN,
    serverId: SERVER_FQDN,
    issuedAt: NOW,
    ...overrides,
  };
}

function mintBody(args?: {
  request?: Partial<ServiceCertMintRequest>;
  authority?: Partial<ServiceCertAuthority>;
  mintSigner?: Keypair;
  authoritySigner?: Keypair;
}): unknown {
  const request = makeMint(args?.request);
  const authority = makeAuthority(args?.authority);
  return {
    request,
    signature: hex(signServiceCertMint(request, args?.mintSigner ?? IRK)),
    authority,
    authoritySignature: hex(signServiceCertAuthority(authority, args?.authoritySigner ?? IRK)),
  };
}

interface FakeIssuerRecord {
  names: string[];
  dns: DnsChallengeWriter | undefined;
}

function makeFakeIssuer(material?: { certPem: string; privateKeyPem: string }): {
  issuer: ServiceCertIssuer;
  issued: FakeIssuerRecord[];
} {
  const issued: FakeIssuerRecord[] = [];
  const issuer: ServiceCertIssuer = {
    async issue(names, perIssue) {
      issued.push({ names, dns: perIssue?.dns });
      return {
        certPem: material?.certPem ?? "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        privateKeyPem: material?.privateKeyPem ?? "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
        notAfter: NOW + 80 * 24 * 60 * 60_000,
      };
    },
  };
  return { issuer, issued };
}

function makeDeps(args?: {
  issuer?: ServiceCertIssuer;
  store?: ServiceCertHttpDeps["store"];
  certManager?: CertManager;
}): {
  deps: ServiceCertHttpDeps;
  grants: { authority: ServiceCertAuthority; signature: Uint8Array }[];
  published: { host: string; value: string }[];
  certManager: CertManager;
} {
  const grants: { authority: ServiceCertAuthority; signature: Uint8Array }[] = [];
  const published: { host: string; value: string }[] = [];
  const certManager = args?.certManager ?? new CertManager();
  const deps: ServiceCertHttpDeps = {
    serverFqdn: SERVER_FQDN,
    username: USERNAME,
    irkPub: IRK.publicKey,
    issuer: args?.issuer ?? makeFakeIssuer().issuer,
    certManager,
    store: args?.store ?? null,
    dnsWriterWithAuthority: (grant) => {
      grants.push(grant);
      return {
        async publishTxt(host, value) {
          published.push({ host, value });
          return async () => {};
        },
      };
    },
    now: () => NOW,
  };
  return { deps, grants, published, certManager };
}

describe("POST /api/service-certs/mint", () => {
  it("verifies both signatures, issues with the authority-carrying DNS writer, persists, and serves the SNI", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "svc-cert-"));
    try {
      const store = new PersistentAcmeStore(tmp);
      const material = await buildAlpnChallengeCert("ka.test", SERVICE_FQDN);
      const fake = makeFakeIssuer(material);
      const { deps, grants, certManager } = makeDeps({ issuer: fake.issuer, store });
      const handle = buildServiceCertHandlers(deps);

      const res = await handle(post("/api/service-certs/mint", mintBody()));
      expect(res?.status).toBe(200);
      expect(json(res!)).toMatchObject({ ok: true, serviceFqdn: SERVICE_FQDN });

      // Issuance covered exactly the one tier-2 name, with the grant attached.
      expect(fake.issued).toHaveLength(1);
      expect(fake.issued[0]!.names).toEqual([SERVICE_FQDN]);
      expect(fake.issued[0]!.dns).toBeDefined();
      expect(grants).toHaveLength(1);
      expect(grants[0]!.authority).toEqual(makeAuthority());
      expect(hex(grants[0]!.signature)).toBe(
        hex(signServiceCertAuthority(makeAuthority(), IRK)),
      );

      // Persisted under the service FQDN with single-name SANs.
      const persisted = await store.loadCert(SERVICE_FQDN);
      expect(persisted?.names).toEqual([SERVICE_FQDN]);
      expect(persisted?.certPem).toBe(material.certPem);

      // The cert serves for its exact SNI (and only there — see the
      // CertManager suite below).
      expect(certManager.contextFor(SERVICE_FQDN)).not.toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("drives the REAL LetsEncryptIssuer over the fake ACME client with the authority forwarded to the DNS-01 publish", async () => {
    const publishedByGrantWriter: { host: string; value: string }[] = [];
    const grants: { authority: ServiceCertAuthority; signature: Uint8Array }[] = [];

    const dnsChallenge = (value: string): AcmeChallenge => ({
      type: "dns-01",
      url: `https://acme/dns/${value}`,
      status: "pending",
      token: `t-${value}`,
    });
    const client: MinimalAcmeClient = {
      async createAccount() {
        return {};
      },
      async createOrder(o) {
        return {
          status: "pending",
          expires: new Date(NOW + 60_000).toISOString(),
          identifiers: o.identifiers,
          authorizations: o.identifiers.map((_, i) => `https://acme/authz/${i}`),
          finalize: "https://acme/finalize",
        } satisfies AcmeOrder;
      },
      async getAuthorizations(o: AcmeOrder): Promise<AcmeAuthorization[]> {
        return o.identifiers.map((id) => ({
          identifier: { type: id.type, value: id.value },
          status: "pending",
          challenges: [dnsChallenge(id.value)],
        }));
      },
      async getChallengeKeyAuthorization(c) {
        return `${c.token}.thumb`;
      },
      async completeChallenge() {
        return {};
      },
      async waitForValidStatus() {
        return {};
      },
      async finalizeOrder(o) {
        return { ...o, status: "valid" };
      },
      async getCertificate() {
        return "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END CERTIFICATE-----\n";
      },
      async revokeCertificate() {},
    };
    const issuer = new LetsEncryptIssuer({
      email: "ops@flagshipserver.com",
      environment: "staging",
      accountKeyPem: "FAKEKEY",
      alpn: { present: () => () => {} },
      // No default DNS writer: the service-cert path must supply its own
      // per-issue writer, proving the override threads end-to-end.
      clientFactory: () => client,
      dns01PropagationDelayMs: 0,
    });

    const handle = buildServiceCertHandlers({
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      irkPub: IRK.publicKey,
      issuer,
      certManager: new CertManager(),
      store: null,
      dnsWriterWithAuthority: (grant) => {
        grants.push(grant);
        return {
          async publishTxt(host, value) {
            publishedByGrantWriter.push({ host, value });
            return async () => {};
          },
        };
      },
      now: () => NOW,
    });

    const res = await handle(post("/api/service-certs/mint", mintBody()));
    expect(res?.status).toBe(200);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.authority.serviceFqdn).toBe(SERVICE_FQDN);
    // The whole order validated via the authority-carrying writer at the
    // service's own challenge name.
    expect(publishedByGrantWriter).toHaveLength(1);
    expect(publishedByGrantWriter[0]!.host).toBe(`_acme-challenge.${SERVICE_FQDN}`);
  });

  it("rejects an authority issued to a DIFFERENT box", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({ authority: { boxServerId: "other.harry1.flagship.services" } }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/not issued to this server/);
  });

  it("rejects an expired authority", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({
          authority: { issuedAt: NOW - 2 * 60 * 60_000, expiresAt: NOW - 60 * 60_000 },
        }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/expired/);
  });

  it("rejects an over-TTL authority window even if it brackets now", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({
          authority: { issuedAt: NOW - 2 * 60 * 60_000, expiresAt: NOW + 60 * 60_000 },
        }),
      ),
    );
    expect(res?.status).toBe(403);
  });

  it("rejects a mint whose serviceFqdn differs from the authority's", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({ authority: { serviceFqdn: "blog.harry1.flagship.services" } }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/does not match the mint request/);
  });

  it("rejects a mint request signed by the wrong key", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post("/api/service-certs/mint", mintBody({ mintSigner: WRONG_IRK })),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/invalid mint signature/);
  });

  it("rejects an authority signed by the wrong key", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post("/api/service-certs/mint", mintBody({ authoritySigner: WRONG_IRK })),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/invalid authority signature/);
  });

  it("rejects a replayed (stale) mint request", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post("/api/service-certs/mint", mintBody({ request: { issuedAt: NOW - 10 * 60_000 } })),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/stale/);
  });

  it("rejects a mint addressed to another box (serverId mismatch)", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({ request: { serverId: "other.harry1.flagship.services" } }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/serverId mismatch/);
  });

  it("rejects the box's OWN fqdn as a serviceFqdn (tier-2 shape can't distinguish it)", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({
          request: { serviceFqdn: SERVER_FQDN },
          authority: { serviceFqdn: SERVER_FQDN },
        }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/own name/);
  });

  it("rejects a non-tier-2 name (deeper hierarchy)", async () => {
    const deep = "x.photos.harry1.flagship.services";
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({ request: { serviceFqdn: deep }, authority: { serviceFqdn: deep } }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/not a tier-2 name/);
  });

  it("rejects a tier-2 name under a DIFFERENT user", async () => {
    const foreign = "photos.mallory.flagship.services";
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/mint",
        mintBody({
          request: { serviceFqdn: foreign, username: "mallory" },
          authority: { serviceFqdn: foreign, username: "mallory" },
        }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/username mismatch/);
  });

  it("returns null for unrelated paths and 405 for GET", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    expect(await handle({ method: "GET", path: "/api/services", headers: {}, body: Buffer.alloc(0) })).toBeNull();
    const r = await handle({ method: "GET", path: "/api/service-certs/mint", headers: {}, body: Buffer.alloc(0) });
    expect(r?.status).toBe(405);
  });
});

function exportBody(args?: {
  request?: Partial<ServiceCertExportRequest>;
  signer?: Keypair;
}): unknown {
  const request: ServiceCertExportRequest = {
    username: USERNAME,
    serviceFqdn: SERVICE_FQDN,
    serverId: SERVER_FQDN,
    issuedAt: NOW,
    ...args?.request,
  };
  return { request, signature: hex(signServiceCertExport(request, args?.signer ?? IRK)) };
}

describe("POST /api/service-certs/export", () => {
  it("returns the PEMs for a service cert this box minted", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    expect((await handle(post("/api/service-certs/mint", mintBody())))?.status).toBe(200);

    const res = await handle(post("/api/service-certs/export", exportBody()));
    expect(res?.status).toBe(200);
    const out = json(res!);
    expect(out.certPem).toMatch(/BEGIN CERTIFICATE/);
    expect(out.privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(typeof out.notAfter).toBe("number");
  });

  it("falls back to the persisted store across a restart (fresh handler, same store)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "svc-cert-"));
    try {
      const store = new PersistentAcmeStore(tmp);
      await store.saveCert(SERVICE_FQDN, {
        certPem: "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nB\n-----END PRIVATE KEY-----\n",
        names: [SERVICE_FQDN],
        notAfter: NOW + 1_000_000,
      });
      const { deps } = makeDeps({ store });
      const handle = buildServiceCertHandlers(deps);
      const res = await handle(post("/api/service-certs/export", exportBody()));
      expect(res?.status).toBe(200);
      expect(json(res!).certPem).toContain("\nA\n");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("never exports the box's own cert through this surface", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "svc-cert-"));
    try {
      const store = new PersistentAcmeStore(tmp);
      await store.saveCert(SERVER_FQDN, {
        certPem: "BOXCERT",
        privateKeyPem: "BOXKEY",
        names: [SERVER_FQDN, `*.${SERVER_FQDN}`],
        notAfter: NOW + 1_000_000,
      });
      const { deps } = makeDeps({ store });
      const handle = buildServiceCertHandlers(deps);
      const res = await handle(
        post("/api/service-certs/export", exportBody({ request: { serviceFqdn: SERVER_FQDN } })),
      );
      expect(res?.status).toBe(403);
      expect(json(res!).error).toMatch(/own name/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("404s when no cert is held for the fqdn", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(post("/api/service-certs/export", exportBody()));
    expect(res?.status).toBe(404);
  });

  it("rejects a tampered export request (signature over different fqdn)", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    await handle(post("/api/service-certs/mint", mintBody()));
    const signedForOther: ServiceCertExportRequest = {
      username: USERNAME,
      serviceFqdn: "blog.harry1.flagship.services",
      serverId: SERVER_FQDN,
      issuedAt: NOW,
    };
    const res = await handle(
      post("/api/service-certs/export", {
        request: { ...signedForOther, serviceFqdn: SERVICE_FQDN },
        signature: hex(signServiceCertExport(signedForOther, IRK)),
      }),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/invalid signature/);
  });

  it("rejects a stale export request", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    await handle(post("/api/service-certs/mint", mintBody()));
    const res = await handle(
      post("/api/service-certs/export", exportBody({ request: { issuedAt: NOW - 10 * 60_000 } })),
    );
    expect(res?.status).toBe(403);
  });
});

function installBody(args?: {
  certPem?: string;
  keyPem?: string;
  bodyCertPem?: string;
  bodyKeyPem?: string;
  request?: Partial<ServiceCertInstall>;
  signer?: Keypair;
}): unknown {
  const certPem = args?.certPem ?? "-----BEGIN CERTIFICATE-----\nSHARED\n-----END CERTIFICATE-----\n";
  const keyPem = args?.keyPem ?? "-----BEGIN PRIVATE KEY-----\nSHAREDKEY\n-----END PRIVATE KEY-----\n";
  const request: ServiceCertInstall = {
    username: USERNAME,
    serviceFqdn: SERVICE_FQDN,
    serverId: SERVER_FQDN,
    certPemSha256: sha256(new TextEncoder().encode(certPem)),
    keyPemSha256: sha256(new TextEncoder().encode(keyPem)),
    notAfter: NOW + 70 * 24 * 60 * 60_000,
    issuedAt: NOW,
    ...args?.request,
  };
  return {
    request: {
      ...request,
      certPemSha256: hex(request.certPemSha256),
      keyPemSha256: hex(request.keyPemSha256),
    },
    signature: hex(signServiceCertInstall(request, args?.signer ?? IRK)),
    certPem: args?.bodyCertPem ?? certPem,
    keyPem: args?.bodyKeyPem ?? keyPem,
  };
}

describe("POST /api/service-certs/install", () => {
  it("verifies the hash-committing signature, persists, and installs for the SNI", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "svc-cert-"));
    try {
      const store = new PersistentAcmeStore(tmp);
      const material = await buildAlpnChallengeCert("ka.install", SERVICE_FQDN);
      const { deps, certManager } = makeDeps({ store });
      const handle = buildServiceCertHandlers(deps);
      const res = await handle(
        post(
          "/api/service-certs/install",
          installBody({ certPem: material.certPem, keyPem: material.privateKeyPem }),
        ),
      );
      expect(res?.status).toBe(200);
      const persisted = await store.loadCert(SERVICE_FQDN);
      expect(persisted?.names).toEqual([SERVICE_FQDN]);
      expect(certManager.contextFor(SERVICE_FQDN)).not.toBeNull();
      // The installed cert is then exportable from THIS box too.
      const exp = await handle(post("/api/service-certs/export", exportBody()));
      expect(exp?.status).toBe(200);
      expect(json(exp!).certPem).toBe(material.certPem);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects swapped cert material (body certPem ≠ signed hash)", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/install",
        installBody({ bodyCertPem: "-----BEGIN CERTIFICATE-----\nEVIL\n-----END CERTIFICATE-----\n" }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/certPem does not match/);
  });

  it("rejects swapped key material (body keyPem ≠ signed hash)", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post(
        "/api/service-certs/install",
        installBody({ bodyKeyPem: "-----BEGIN PRIVATE KEY-----\nEVIL\n-----END PRIVATE KEY-----\n" }),
      ),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/keyPem does not match/);
  });

  it("rejects an install signed by the wrong key", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post("/api/service-certs/install", installBody({ signer: WRONG_IRK })),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/invalid signature/);
  });

  it("rejects an already-expired cert", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post("/api/service-certs/install", installBody({ request: { notAfter: NOW - 1 } })),
    );
    expect(res?.status).toBe(403);
    expect(json(res!).error).toMatch(/expired/);
  });

  it("rejects a stale install request", async () => {
    const { deps } = makeDeps();
    const handle = buildServiceCertHandlers(deps);
    const res = await handle(
      post("/api/service-certs/install", installBody({ request: { issuedAt: NOW - 10 * 60_000 } })),
    );
    expect(res?.status).toBe(403);
  });
});

describe("CertManager — service-cert SNI exactness", () => {
  it("presents the service cert for its exact SNI and for NO other name", async () => {
    const cm = new CertManager();
    const material = await buildAlpnChallengeCert("ka.sni", SERVICE_FQDN);
    cm.installCustom(SERVICE_FQDN, material, NOW + 1_000_000);

    expect(cm.contextFor(SERVICE_FQDN)).not.toBeNull();
    expect(cm.contextFor(SERVICE_FQDN.toUpperCase())).not.toBeNull();
    // No real (per-box) cert is installed, so every other name must
    // get NOTHING — the service cert never leaks onto other SNIs.
    expect(cm.contextFor(SERVER_FQDN)).toBeNull();
    expect(cm.contextFor("blog.harry1.flagship.services")).toBeNull();
    expect(cm.contextFor(`x.${SERVICE_FQDN}`)).toBeNull();
  });
});

describe("rehydrateServiceCerts", () => {
  afterEach(async () => {});

  it("reloads persisted tier-2 service certs and skips box/expired/deep/wildcard entries", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "svc-rehydrate-"));
    try {
      const store = new PersistentAcmeStore(tmp);
      const material = await buildAlpnChallengeCert("ka.re", SERVICE_FQDN);
      // The box's own cert — NOT a service cert (two names, incl. wildcard).
      await store.saveCert(SERVER_FQDN, {
        certPem: material.certPem,
        privateKeyPem: material.privateKeyPem,
        names: [SERVER_FQDN, `*.${SERVER_FQDN}`],
        notAfter: NOW + 1_000_000,
      });
      // A live service cert.
      await store.saveCert(SERVICE_FQDN, {
        certPem: material.certPem,
        privateKeyPem: material.privateKeyPem,
        names: [SERVICE_FQDN],
        notAfter: NOW + 1_000_000,
      });
      // An expired one — never re-served.
      await store.saveCert("old.harry1.flagship.services", {
        certPem: material.certPem,
        privateKeyPem: material.privateKeyPem,
        names: ["old.harry1.flagship.services"],
        notAfter: NOW - 1,
      });
      // A deep (non-tier-2) single name — not a service cert.
      await store.saveCert("a.b.harry1.flagship.services", {
        certPem: material.certPem,
        privateKeyPem: material.privateKeyPem,
        names: ["a.b.harry1.flagship.services"],
        notAfter: NOW + 1_000_000,
      });

      const cm = new CertManager();
      const installed = await rehydrateServiceCerts({
        store,
        certManager: cm,
        serverFqdn: SERVER_FQDN,
        now: NOW,
      });
      expect(installed).toEqual([SERVICE_FQDN]);
      expect(cm.contextFor(SERVICE_FQDN)).not.toBeNull();
      expect(cm.contextFor("old.harry1.flagship.services")).toBeNull();
      expect(cm.contextFor(SERVER_FQDN)).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns empty for an empty store dir", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "svc-rehydrate-"));
    try {
      const store = new PersistentAcmeStore(tmp);
      const installed = await rehydrateServiceCerts({
        store,
        certManager: new CertManager(),
        serverFqdn: SERVER_FQDN,
        now: NOW,
      });
      expect(installed).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("RemoteDnsChallengeWriter — forwarded ServiceCertAuthority", () => {
  function makeWriter() {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = async (url: string, init?: { body?: string }) => {
      requests.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return {
        ok: true,
        status: 200,
        async json() {
          return { recordId: "rec-1" };
        },
        async text() {
          return "";
        },
      };
    };
    const writer = new RemoteDnsChallengeWriter({
      controlPlaneBaseUrl: "https://example.test",
      serverId: SERVER_FQDN,
      stk: kp(3),
      fetchImpl: fetchImpl as never,
      now: () => NOW,
    });
    return { writer, requests };
  }

  it("includes the authority envelope on publish AND the matching delete", async () => {
    const { writer, requests } = makeWriter();
    const authority = makeAuthority();
    const signature = signServiceCertAuthority(authority, IRK);
    const granted = writer.withServiceCertAuthority({ authority, signature });

    const dispose = await granted.publishTxt(`_acme-challenge.${SERVICE_FQDN}`, "v1");
    await dispose();

    expect(requests).toHaveLength(2);
    const publish = requests[0]!;
    expect(publish.url).toBe("https://example.test/api/dns-01/publish");
    expect(publish.body.serviceCertAuthority).toEqual({
      authority,
      signature: hex(signature),
    });
    const del = requests[1]!;
    expect(del.url).toBe("https://example.test/api/dns-01/delete");
    expect(del.body.serviceCertAuthority).toEqual({
      authority,
      signature: hex(signature),
    });
  });

  it("omits the envelope entirely on the plain per-box writer", async () => {
    const { writer, requests } = makeWriter();
    const dispose = await writer.publishTxt(`_acme-challenge.${SERVER_FQDN}`, "v2");
    await dispose();
    expect(requests[0]!.body).not.toHaveProperty("serviceCertAuthority");
    expect(requests[1]!.body).not.toHaveProperty("serviceCertAuthority");
  });
});

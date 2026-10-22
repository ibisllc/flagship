import { describe, expect, it } from "vitest";
import {
  ed,
  deriveIRK,
  deriveSWK,
  verifyMarketplaceList,
  type MarketplaceListRequest,
} from "@flagship/protocol";
import { sha256 } from "@noble/hashes/sha256";
import { AppMembership } from "../../src/membership.js";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import type { ScreensHttpDeps } from "../../src/screens/screensHttp.js";
import { swkOps } from "../helpers/keyCustody.js";
import type { HttpRequest } from "../../src/runtime.js";
import type { InstalledService } from "../../src/servicePlatform.js";
import type { FetchLike } from "@flagship/llm-providers";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";
const TOKEN = "tok-good";

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
}

function fakeGate() {
  return {
    has: (t: string) => t === TOKEN,
    check: (r: HttpRequest) =>
      r.headers["x-flagship-session"] === TOKEN
        ? null
        : { status: 401, headers: {}, body: JSON.stringify({ error: "unauthorized" }) },
  } as unknown as ScreensHttpDeps["gate"];
}

function makeInstalledService(over: Partial<InstalledService> = {}): InstalledService {
  const umk = { seed: new Uint8Array(32).fill(7) };
  const irk = deriveIRK(umk);
  const swk = swkOps(deriveSWK(umk, "srv-1"));
  return {
    creator: USERNAME,
    slug: "habits",
    serviceId: "alice-habits",
    manifest: {
      schema_version: 1,
      name: "Habits",
      description: "Track daily habits",
      version: "0.1.0",
      runtime: { image: "img:1", port: 8080 },
      data: {},
      network: { subdomain: "habits" },
      access: { enabled: true, default_role: "owner" },
      migration: { verification: "standard" },
      distribution: { public: true },
    } as unknown as InstalledService["manifest"],
    urlLabel: "habits",
    membership: new AppMembership("habits", USERNAME, irk.publicKey, swk),
    containerPort: 8080,
    data: null,
    installedAt: 1_000,
    ...over,
  };
}

function fakeServicePlatform(apps: InstalledService[]) {
  return { list: () => apps } as unknown as ScreensHttpDeps["servicePlatform"];
}

function boxKeypair() {
  const privateKey = new Uint8Array(32).fill(9);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

/** Captures the .com listing-upsert POST and returns a 200. */
function capturingFetch(): { fetchImpl: FetchLike; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ ok: true }),
    };
  };
  return { fetchImpl, calls };
}

const COMMON: Omit<ScreensHttpDeps, "gate"> = {
  serverFqdn: SERVER_FQDN,
  username: USERNAME,
  daemonVersion: "0.0.1-test",
  startedAt: 1_000,
  now: () => 5_000,
};

function sha256Hex(s: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(s))).toString("hex");
}

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("POST /api/screens/marketplace/publish", () => {
  it("builds a signed listing from the service manifest and submits it to .com", async () => {
    const key = boxKeypair();
    const { fetchImpl, calls } = capturingFetch();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([makeInstalledService()]),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      marketplacePublish: { signingKey: key, creatorUsername: USERNAME },
    });

    const r = await handle(req({
      method: "POST",
      path: "/api/screens/marketplace/publish",
      headers: { "x-flagship-session": TOKEN },
      body: Buffer.from(JSON.stringify({ serviceCanonical: "alice-habits" })),
    }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(r!.body as string)).toMatchObject({ ok: true, slug: "habits", creator: "alice" });

    // The listing was POSTed to .com's upsert with a valid box-signed request.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://flagshipserver.com/api/marketplace/list");
    const sent = JSON.parse(calls[0]!.body) as { request: MarketplaceListRequest; signature: string };
    expect(sent.request.creator).toBe("alice");
    expect(sent.request.slug).toBe("habits");
    expect(sent.request.canonicalUrl).toBe("habits.alice.flagship.services");
    expect(sent.request.publicDistribution).toBe(true);
    // manifest carried + hash committed (Blocker 1).
    expect(sent.request.manifestJson).toContain("\"Habits\"");
    expect(sent.request.manifestHashHex).toBe(sha256Hex(sent.request.manifestJson));
    // signed by the box identity key.
    expect(verifyMarketplaceList(sent.request, hexToBytes(sent.signature), key.publicKey)).toBe(true);
  });

  it("503s when publish isn't configured", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([makeInstalledService()]),
      controlPlaneBaseUrl: "https://flagshipserver.com",
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/marketplace/publish",
      headers: { "x-flagship-session": TOKEN },
      body: Buffer.from(JSON.stringify({ serviceCanonical: "alice-habits" })),
    }));
    expect(r?.status).toBe(503);
  });

  it("404s when the service isn't installed on this box", async () => {
    const { fetchImpl } = capturingFetch();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([]),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      marketplacePublish: { signingKey: boxKeypair(), creatorUsername: USERNAME },
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/marketplace/publish",
      headers: { "x-flagship-session": TOKEN },
      body: Buffer.from(JSON.stringify({ serviceCanonical: "alice-habits" })),
    }));
    expect(r?.status).toBe(404);
  });

  it("403s when the app was authored by another account", async () => {
    const { fetchImpl } = capturingFetch();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([makeInstalledService({ creator: "bob", serviceId: "bob-habits" })]),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      marketplacePublish: { signingKey: boxKeypair(), creatorUsername: USERNAME },
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/marketplace/publish",
      headers: { "x-flagship-session": TOKEN },
      body: Buffer.from(JSON.stringify({ serviceCanonical: "bob-habits" })),
    }));
    expect(r?.status).toBe(403);
  });
});

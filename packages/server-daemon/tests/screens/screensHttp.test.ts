import { describe, expect, it } from "vitest";
import { ed, deriveIRK, deriveSWK } from "@flagship/protocol";
import { AppMembership } from "../../src/membership.js";
import {
  buildScreensHttp,
  type OrdersDispatchLike,
  type ScreensHttpDeps,
  type UrlControllerLike,
  type InstallEventLog,
  type VibeCodeRuntime,
} from "../../src/screens/screensHttp.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import type { OwnedUrl } from "../../src/screens/types.js";
import type { HttpRequest } from "../../src/runtime.js";
import type { InstalledService } from "../../src/servicePlatform.js";
import type { FetchLike } from "@flagship/llm-providers";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: {},
    body: Buffer.alloc(0),
    ...over,
  };
}

function fakeGate(allowToken = "tok-good") {
  return {
    has(t: string) {
      return t === allowToken;
    },
    check(r: HttpRequest) {
      const hdr = r.headers["x-flagship-session"];
      if (typeof hdr === "string" && hdr === allowToken) return null;
      const idx = r.path.indexOf("?");
      if (idx >= 0) {
        const sp = new URLSearchParams(r.path.slice(idx + 1));
        if (sp.get("sessionToken") === allowToken) return null;
      }
      return { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unauthorized" }) };
    },
  };
}

function fakePairedSessions(sessions: Array<{ token: string; label: string; addedAt: number }>) {
  const map = new Map(sessions.map((s) => [s.token, s]));
  return {
    list: () => [...map.values()],
    has: (t: string) => map.has(t),
    add: async (t: string, label: string) => {
      map.set(t, { token: t, label, addedAt: Date.now() });
    },
    remove: async (t: string) => {
      map.delete(t);
    },
  } as unknown as ScreensHttpDeps["pairedSessions"];
}

function fakeUrlController(initial: string[] = []): UrlControllerLike & { claimed: string[] } {
  const claimed = [...initial];
  return {
    claimed,
    async claim(fqdn: string) {
      if (!claimed.includes(fqdn)) claimed.push(fqdn);
    },
    async release(fqdn: string) {
      const i = claimed.indexOf(fqdn);
      if (i >= 0) claimed.splice(i, 1);
    },
    list: () => [...claimed],
  };
}

function makeMembership(): AppMembership {
  const umk = { seed: new Uint8Array(32).fill(7) };
  const irk = deriveIRK(umk);
  const swk = deriveSWK(umk, "srv-1");
  return new AppMembership("habits", USERNAME, irk.publicKey, swk);
}

function makeInstalledService(over: Partial<InstalledService> = {}): InstalledService {
  const membership = over.membership ?? makeMembership();
  return {
    creator: USERNAME,
    slug: "habits",
    serviceId: "alice-habits",
    manifest: {
      schema_version: 1,
      name: "habits",
      description: "Track daily habits",
      version: "0.1.0",
      runtime: { image: "img:1", port: 8080 },
      data: {},
      network: { subdomain: "habits" },
      access: { enabled: true, default_role: "owner" },
      migration: { verification: "standard" },
    } as unknown as InstalledService["manifest"],
    urlLabel: "habits",
    membership,
    containerPort: 8080,
    data: null,
    installedAt: 1_000,
    ...over,
  };
}

function fakeServicePlatform(apps: InstalledService[]) {
  return {
    list: () => apps,
    byServiceId: (id: string) => apps.find((a) => a.serviceId === id),
    byLabel: (l: string) => apps.find((a) => a.urlLabel === l),
  } as unknown as ScreensHttpDeps["servicePlatform"];
}

const COMMON: Omit<ScreensHttpDeps, "gate"> = {
  serverFqdn: SERVER_FQDN,
  username: USERNAME,
  daemonVersion: "0.0.1-test",
  startedAt: 1_000,
  now: () => 5_000,
};

describe("screens HTTP — auth + dispatch", () => {
  it("returns null for non-/api/screens paths (lets the chain fall through)", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({ path: "/api/health" }));
    expect(r).toBeNull();
  });

  it("returns 401 when paired-session gate denies", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({ path: "/api/screens/server-detail" }));
    expect(r?.status).toBe(401);
  });

  it("returns 404 for an unknown /api/screens/* path", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/no-such-thing",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(404);
  });
});

describe("screens HTTP — P1.1 server-detail", () => {
  it("returns server identity, uptime, app count, paired-session count, and cert info", async () => {
    const installEventLog: InstallEventLog = {
      recent: () => [
        { at: 100, kind: "installed", serviceId: "alice-habits", detail: "" },
      ],
    };
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([makeInstalledService()]),
      pairedSessions: fakePairedSessions([
        { token: "tok-good", label: "phone", addedAt: 200 },
        { token: "tok-laptop", label: "laptop", addedAt: 300 },
      ]),
      certInfo: () => ({
        notAfter: 9_000,
        notBefore: 100,
        sans: [SERVER_FQDN, `*.${SERVER_FQDN}`],
      }),
      installEventLog,
    });
    const r = await handle(req({
      path: "/api/screens/server-detail",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.serverFqdn).toBe(SERVER_FQDN);
    expect(body.username).toBe(USERNAME);
    expect(body.uptimeMs).toBe(4_000); // now=5000 - startedAt=1000
    expect(body.serviceCount).toBe(1);
    expect(body.pairedSessionCount).toBe(2);
    expect(body.certNotAfter).toBe(9_000);
    expect(body.certSans).toEqual([SERVER_FQDN, `*.${SERVER_FQDN}`]);
    expect(body.recentInstallEvents).toHaveLength(1);
  });

  it("degrades cleanly when subsystems are null (no app-platform / no certs / no event log)", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
    });
    const r = await handle(req({
      path: "/api/screens/server-detail",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.serviceCount).toBe(0);
    expect(body.pairedSessionCount).toBe(0);
    expect(body.recentInstallEvents).toEqual([]);
    expect(body.certNotAfter).toBeUndefined();
  });
});

describe("screens HTTP — P1.2 apps-list", () => {
  it("returns each installed app's summary with the canonical URL", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([
        makeInstalledService({ slug: "habits", serviceId: "alice-habits", urlLabel: "habits" }),
        makeInstalledService({
          slug: "game1",
          creator: "bob",
          serviceId: "bob-game1",
          urlLabel: "game1-bob",
        }),
      ]),
    });
    const r = await handle(req({
      path: "/api/screens/apps-list",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.apps).toHaveLength(2);
    expect(body.apps[0].url).toBe(`https://habits.${SERVER_FQDN}`);
    expect(body.apps[1].url).toBe(`https://game1-bob.${SERVER_FQDN}`);
    expect(body.apps[0].summary).toBe("Track daily habits");
  });

  it("returns an empty array when no app-platform is configured", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/apps-list",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(r!.body as string).apps).toEqual([]);
  });
});

describe("screens HTTP — P1.3 app-detail/:serviceId", () => {
  it("returns 503 when no app-platform is wired", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/app-detail/alice-habits",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(503);
  });

  it("returns 404 when the app id is unknown", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([]),
    });
    const r = await handle(req({
      path: "/api/screens/app-detail/alice-nope",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(404);
  });

  it("returns the app's manifest, members (truncated), and tab list", async () => {
    const app = makeInstalledService();
    // Seed a member by directly using internalAdd
    const otherPriv = new Uint8Array(32);
    crypto.getRandomValues(otherPriv);
    const otherPub = ed.getPublicKey(otherPriv);
    app.membership.members.internalAdd(otherPub, "viewer");
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([app]),
      tabRegistry: {
        tabsForApp: () => ["tab-1", "tab-2"],
      } as unknown as ScreensHttpDeps["tabRegistry"],
    });
    const r = await handle(req({
      path: "/api/screens/app-detail/alice-habits",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.app.serviceId).toBe("alice-habits");
    expect(body.manifest.name).toBe("habits");
    expect(body.browserTabs).toHaveLength(2);
    expect(body.members.length).toBeGreaterThan(0);
    // stableIdPrefix is truncated
    for (const m of body.members) {
      expect(m.stableIdPrefix.length).toBeLessThanOrEqual(12);
    }
  });
});

describe("screens HTTP — P1.12 paired-sessions/list", () => {
  it("returns truncated token prefixes + tags the calling session as 'current'", async () => {
    const PHONE_TOKEN = "phone-tok-12345abcdef";
    const LAPTOP_TOKEN = "laptop-tok-67890zyxwv";
    const handle = buildScreensHttp({
      ...COMMON,
      // The phone is the caller, so the gate must accept its full token.
      gate: fakeGate(PHONE_TOKEN),
      pairedSessions: fakePairedSessions([
        { token: PHONE_TOKEN, label: "phone", addedAt: 100 },
        { token: LAPTOP_TOKEN, label: "laptop", addedAt: 200 },
      ]),
    });
    const r = await handle(req({
      path: "/api/screens/paired-sessions/list",
      headers: { "x-flagship-session": PHONE_TOKEN },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.sessions).toHaveLength(2);
    const phone = body.sessions.find((s: { label: string }) => s.label === "phone");
    expect(phone.tokenPrefix).toBe(PHONE_TOKEN.slice(0, 12));
    expect(phone.current).toBe(true);
    const laptop = body.sessions.find((s: { label: string }) => s.label === "laptop");
    expect(laptop.current).toBe(false);
    // Full tokens are never returned
    expect(JSON.stringify(body)).not.toContain(PHONE_TOKEN);
    expect(JSON.stringify(body)).not.toContain(LAPTOP_TOKEN);
  });
});

describe("screens HTTP — P1.13 paired-sessions DELETE", () => {
  it("revokes the session matching the prefix", async () => {
    const sessions = fakePairedSessions([
      { token: "abcdefgh1111", label: "a", addedAt: 1 },
      { token: "12345678abcd", label: "b", addedAt: 2 },
    ]);
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      pairedSessions: sessions,
    });
    const r = await handle(req({
      method: "DELETE",
      path: "/api/screens/paired-sessions/abcdefgh",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(sessions!.list()).toHaveLength(1);
    expect(sessions!.list()[0]!.token).toBe("12345678abcd");
  });

  it("rejects too-short prefixes", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      pairedSessions: fakePairedSessions([{ token: "abcdefgh1111", label: "a", addedAt: 1 }]),
    });
    const r = await handle(req({
      method: "DELETE",
      path: "/api/screens/paired-sessions/abc",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(400);
  });

  it("returns 409 when the prefix matches multiple tokens", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      pairedSessions: fakePairedSessions([
        { token: "abcdefgh1111", label: "a", addedAt: 1 },
        { token: "abcdefgh2222", label: "b", addedAt: 2 },
      ]),
    });
    const r = await handle(req({
      method: "DELETE",
      path: "/api/screens/paired-sessions/abcdefgh",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(409);
  });

  it("returns 404 when no session matches", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      pairedSessions: fakePairedSessions([{ token: "abcdefgh1111", label: "a", addedAt: 1 }]),
    });
    const r = await handle(req({
      method: "DELETE",
      path: "/api/screens/paired-sessions/zzzzzzzz",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(404);
  });
});

describe("screens HTTP — P1.17 url-controller/owned", () => {
  it("includes the canonical FQDN + classifies aliases vs custom domains", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      urlController: fakeUrlController([
        // alias inside the user zone
        `mail.${SERVER_FQDN}`,
        `${SERVER_FQDN.replace("home", "mail")}`,
        // custom outside the zone
        "mybrand.com",
      ]),
    });
    const r = await handle(req({
      path: "/api/screens/url-controller/owned",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    const canonical = body.urls.find((u: OwnedUrl) => u.kind === "canonical");
    expect(canonical.fqdn).toBe(SERVER_FQDN);
    const custom = body.urls.find((u: OwnedUrl) => u.fqdn === "mybrand.com");
    expect(custom.kind).toBe("custom");
    const alias = body.urls.find((u: OwnedUrl) => u.fqdn.startsWith("mail."));
    expect(alias.kind).toBe("alias");
  });
});

describe("screens HTTP — P1.18 url-controller/claim", () => {
  it("rejects bodies without an fqdn", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      urlController: fakeUrlController(),
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/url-controller/claim",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from("{}"),
    }));
    expect(r?.status).toBe(400);
  });

  it("delegates to urlController.claim() and returns ok", async () => {
    const ctrl = fakeUrlController();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      urlController: ctrl,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/url-controller/claim",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ fqdn: "habits.flagship.services" })),
    }));
    expect(r?.status).toBe(200);
    expect(ctrl.claimed).toContain("habits.flagship.services");
  });

  it("returns 502 when the underlying claim throws", async () => {
    const ctrl: UrlControllerLike = {
      claim: async () => {
        throw new Error("hub rejected");
      },
      release: async () => {},
      list: () => [],
    };
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      urlController: ctrl,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/url-controller/claim",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ fqdn: "x.example.com" })),
    }));
    expect(r?.status).toBe(502);
  });

  it("returns 503 when no urlController is wired", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/url-controller/claim",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ fqdn: "x.example.com" })),
    }));
    expect(r?.status).toBe(503);
  });
});

// ----- helpers used by the proxy / vibe-code / orders / backup tests -----

function jsonOk(body: unknown): { ok: true; status: 200; text(): Promise<string>; json(): Promise<unknown> } {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function jsonFail(status: number, body: unknown) {
  return {
    ok: false,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

describe("screens HTTP — P1.4 marketplace-browse (proxy)", () => {
  it("proxies to .com and tags installed apps", async () => {
    const upstream = {
      listings: [
        { creator: "alice", slug: "habits", title: "Habits", summary: "x", installCount: 5, requiresLlmKey: false, screenshots: ["s1"] },
        { creator: "bob", slug: "game1", title: "Game", summary: "y", installCount: 1, requiresLlmKey: true, screenshots: [] },
      ],
    };
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (url: string) => {
      calls.push(url);
      return jsonOk(upstream) as never;
    };
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fakeFetch,
      // alice/habits is installed locally
      servicePlatform: fakeServicePlatform([makeInstalledService({ creator: "alice", slug: "habits" })]),
    });
    const r = await handle(req({
      path: "/api/screens/marketplace-browse",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(calls[0]).toBe("https://flagshipserver.com/api/marketplace/search");
    const body = JSON.parse(r!.body as string);
    const habit = body.listings.find((l: { slug: string }) => l.slug === "habits");
    expect(habit.alreadyInstalled).toBe(true);
    const game = body.listings.find((l: { slug: string }) => l.slug === "game1");
    expect(game.alreadyInstalled).toBe(false);
    expect(game.requiresLlmKey).toBe(true);
  });

  it("returns 503 when no control plane is configured", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/marketplace-browse",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(503);
  });
});

describe("screens HTTP — P1.16 tier-status", () => {
  it("returns the upstream tier when .com is healthy", async () => {
    const fakeFetch: FetchLike = async () =>
      jsonOk({
        tier: "byok",
        customDomains: ["mybrand.com"],
        reservedNames: [],
        dispatcherUsageGBmonth: 1.2,
        dispatcherFreeQuotaGBmonth: 50,
      }) as never;
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fakeFetch,
    });
    const r = await handle(req({
      path: "/api/screens/tier-status",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.tier).toBe("byok");
    expect(body.customDomains).toEqual(["mybrand.com"]);
  });

  it("falls back to free-tier on upstream 5xx instead of erroring", async () => {
    const fakeFetch: FetchLike = async () => jsonFail(503, "down") as never;
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fakeFetch,
    });
    const r = await handle(req({
      path: "/api/screens/tier-status",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.tier).toBe("free");
  });

  it("returns free-tier when no control plane is configured", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/tier-status",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(r!.body as string).tier).toBe("free");
  });
});

describe("screens HTTP — P1.5 / P1.7 vibe-code", () => {
  function makeVibeCode(): { runtime: VibeCodeRuntime; registry: VibeCodeSessionRegistry; startCalls: Array<{ sessionId: string; prompt: string }> } {
    const registry = new VibeCodeSessionRegistry();
    const startCalls: Array<{ sessionId: string; prompt: string }> = [];
    const runtime: VibeCodeRuntime = {
      registry,
      username: USERNAME,
      serverFqdn: SERVER_FQDN,
      startStreaming: async ({ sessionId, prompt }) => {
        startCalls.push({ sessionId, prompt });
      },
    };
    return { runtime, registry, startCalls };
  }

  it("start: returns sessionId + invokes startStreaming exactly once", async () => {
    const { runtime, startCalls } = makeVibeCode();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      vibeCode: runtime,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/vibe-code/start",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ prompt: "build a habit tracker" })),
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(typeof body.sessionId).toBe("string");
    // Wait one tick for the fire-and-forget to land
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.prompt).toBe("build a habit tracker");
  });

  it("start: rejects empty prompt with 400", async () => {
    const { runtime } = makeVibeCode();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      vibeCode: runtime,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/vibe-code/start",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ prompt: "" })),
    }));
    expect(r?.status).toBe(400);
  });

  it("start: returns 503 when vibe-code is not wired", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/vibe-code/start",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ prompt: "x" })),
    }));
    expect(r?.status).toBe(503);
  });

  it("status: returns transcript + files", async () => {
    const { runtime, registry } = makeVibeCode();
    const session = registry.create({ username: USERNAME, serverFqdn: SERVER_FQDN });
    session.pushUserMessage("describe");
    session.feedAssistant("=== flagship.app.json ===\n{}\n=== END ===\n");
    session.endAssistant();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      vibeCode: runtime,
    });
    const r = await handle(req({
      path: `/api/screens/vibe-code/${session.meta.sessionId}`,
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.status).toBe("ready-to-deploy");
    expect(body.transcript[0].role).toBe("user");
    expect(Object.keys(body.files)).toContain("flagship.app.json");
  });

  it("status: 404 for unknown session id", async () => {
    const { runtime } = makeVibeCode();
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      vibeCode: runtime,
    });
    const r = await handle(req({
      path: "/api/screens/vibe-code/no-such",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(404);
  });
});

describe("screens HTTP — P1.14 orders/send", () => {
  it("base64-decodes the envelope and forwards to the dispatcher", async () => {
    const seenEnvelopes: Buffer[] = [];
    const dispatch: OrdersDispatchLike = {
      dispatch: async ({ envelope }) => {
        seenEnvelopes.push(envelope);
        return { ok: true, response: { ack: 1 } };
      },
    };
    const payload = Buffer.from("hello-order");
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      ordersDispatch: dispatch,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/orders/send",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ envelope: payload.toString("base64"), kind: "noop" })),
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.ok).toBe(true);
    expect(seenEnvelopes).toHaveLength(1);
    expect(seenEnvelopes[0]!.equals(payload)).toBe(true);
  });

  it("rejects when envelope is missing", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      ordersDispatch: { dispatch: async () => ({ ok: true }) },
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/orders/send",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ kind: "noop" })),
    }));
    expect(r?.status).toBe(400);
  });
});

describe("screens HTTP — P1.19 / P1.20 app-backup", () => {
  it("start: parses serviceId, calls AppBackupService.createBackup, returns metadata", async () => {
    const fakeBackup = {
      createBackup: async (spec: { creator: string; slug: string }) => ({
        backupId: "abc123",
        fetchPath: "/api/backups/abc123",
        path: "/tmp/abc123.tar.gz",
        expiresAt: 9999,
        bytes: 1024,
        encrypted: false,
        creator: spec.creator,
        slug: spec.slug,
      }),
    } as unknown as ScreensHttpDeps["appBackup"];
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      appBackup: fakeBackup,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/app-backup/start",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ serviceId: "alice-habits", includeUserData: false })),
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.backupId).toBe("abc123");
    expect(body.fetchPath).toBe("/api/backups/abc123");
    expect(body.encrypted).toBe(false);
  });

  it("start: 400 on malformed serviceId", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      appBackup: { createBackup: async () => ({}) } as unknown as ScreensHttpDeps["appBackup"],
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/app-backup/start",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ serviceId: "nocreatorseparator" })),
    }));
    expect(r?.status).toBe(400);
  });

  it("fetch: 307-redirects to /api/backups/<id>", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/app-backup/abc123",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(307);
    expect(r?.headers?.location).toBe("/api/backups/abc123");
  });

  it("fetch: 400 on non-hex backupId", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/app-backup/zzz",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(400);
  });
});

describe("screens HTTP — P1.10 browser-tabs/list/:serviceId", () => {
  it("returns the tab ids tabRegistry.tabsForApp() reports", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([makeInstalledService()]),
      tabRegistry: {
        tabsForApp: () => ["t1", "t2"],
      } as unknown as ScreensHttpDeps["tabRegistry"],
    });
    const r = await handle(req({
      path: "/api/screens/browser-tabs/list/alice-habits",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.tabs.map((t: { tabId: string }) => t.tabId)).toEqual(["t1", "t2"]);
    expect(body.tabs[0].serviceId).toBe("alice-habits");
  });

  it("returns an empty list when no tabRegistry is wired", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      servicePlatform: fakeServicePlatform([makeInstalledService()]),
    });
    const r = await handle(req({
      path: "/api/screens/browser-tabs/list/alice-habits",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(r!.body as string).tabs).toEqual([]);
  });
});

describe("screens HTTP — non-WS hits on /stream paths fall through to 501", () => {
  it("vibe-code/:id/stream returns 501 — WS upgrade goes via screensWs.ts", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/vibe-code/abc/stream",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(501);
    expect(JSON.parse(r!.body as string).error).toMatch(/WebSocket|poll/);
  });

  it("browser-tabs/:tabId/stream returns 501 (P1.11 still unimplemented)", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/browser-tabs/tab1/stream",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(501);
  });
});

describe("screens HTTP — P1.15 install-events JSON poll proxy", () => {
  it("forwards GET to .com /api/install-events/<serial>?since=...", async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (url: string) => {
      calls.push(url);
      return jsonOk({ events: [{ kind: "ready", at: 5, serverFqdn: "x" }], cursor: 7 }) as never;
    };
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fakeFetch,
    });
    const r = await handle(req({
      path: "/api/screens/install-events/SN42?since=3",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(calls[0]).toBe("https://flagshipserver.com/api/install-events/SN42?since=3");
    const body = JSON.parse(r!.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.cursor).toBe(7);
    // No-store cache header so polling clients always see fresh state.
    expect(r?.headers?.["cache-control"]).toBe("no-store");
  });

  it("defaults `since` to 0 when not provided", async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (url: string) => {
      calls.push(url);
      return jsonOk({ events: [] }) as never;
    };
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fakeFetch,
    });
    await handle(req({
      path: "/api/screens/install-events/SN42",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(calls[0]).toContain("since=0");
  });

  it("returns 502 when upstream is non-2xx", async () => {
    const fakeFetch: FetchLike = async () => jsonFail(503, "down") as never;
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fakeFetch,
    });
    const r = await handle(req({
      path: "/api/screens/install-events/SN42",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(502);
  });

  it("returns 503 when control plane is not configured", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/install-events/SN42",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(503);
  });

  it("returns 405 for non-GET methods on install-events", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      controlPlaneBaseUrl: "https://flagshipserver.com",
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/install-events/SN42",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(405);
  });
});

describe("screens HTTP — /api/screens/lineage-resolve", () => {
  function fakeResolver(initial: Array<{
    serviceId: string;
    creator: string;
    slug: string;
    canonicalUrl: string;
    detectedAt: number;
    lineageAnchor: string;
    priorTip: string;
    upstreamTip: string;
    reason: string;
    detail: string;
  }>) {
    const accepted: string[] = [];
    const revoked: string[] = [];
    return {
      accepted,
      revoked,
      list: async () => initial.slice(),
      accept: async (serviceId: string) => {
        accepted.push(serviceId);
        return { ok: true as const, outcome: "accepted" as const };
      },
      revoke: async (serviceId: string) => {
        revoked.push(serviceId);
        return { ok: true };
      },
    };
  }

  it("GET returns the paused list", async () => {
    const resolver = fakeResolver([
      {
        serviceId: "alice-game1",
        creator: "alice",
        slug: "game1",
        canonicalUrl: "game1.alice.flagship.services",
        detectedAt: 12345,
        lineageAnchor: "anchor1",
        priorTip: "prior1",
        upstreamTip: "evil1",
        reason: "anchor-unreachable",
        detail: "rebuilt repo detected",
      },
    ]);
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      lineageResolver: resolver,
    });
    const r = await handle(req({
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.paused).toHaveLength(1);
    expect(body.paused[0].serviceId).toBe("alice-game1");
    expect(body.paused[0].reason).toBe("anchor-unreachable");
  });

  it("GET returns empty list when resolver unset", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(r!.body as string)).toEqual({ paused: [] });
  });

  it("POST accept routes to resolver.accept", async () => {
    const resolver = fakeResolver([]);
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      lineageResolver: resolver,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ serviceId: "alice-game1", decision: "accept" })),
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body).toEqual({ ok: true, outcome: "accepted" });
    expect(resolver.accepted).toEqual(["alice-game1"]);
  });

  it("POST revoke routes to resolver.revoke", async () => {
    const resolver = fakeResolver([]);
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      lineageResolver: resolver,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ serviceId: "alice-game1", decision: "revoke" })),
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body).toEqual({ ok: true, outcome: "revoked" });
    expect(resolver.revoked).toEqual(["alice-game1"]);
  });

  it("POST returns 400 on missing serviceId / bad decision", async () => {
    const resolver = fakeResolver([]);
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      lineageResolver: resolver,
    });
    const noAppId = await handle(req({
      method: "POST",
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ decision: "accept" })),
    }));
    expect(noAppId?.status).toBe(400);
    const badDecision = await handle(req({
      method: "POST",
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ serviceId: "alice-game1", decision: "burn-it-down" })),
    }));
    expect(badDecision?.status).toBe(400);
  });

  it("POST returns 503 when resolver unset", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ serviceId: "alice-game1", decision: "accept" })),
    }));
    expect(r?.status).toBe(503);
  });

  it("POST surfaces resolver.accept failure as 502", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      lineageResolver: {
        list: async () => [],
        accept: async () => ({ ok: false, outcome: "already-clear" as const, reason: "no state" }),
        revoke: async () => ({ ok: true }),
      },
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/screens/lineage-resolve",
      headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ serviceId: "alice-game1", decision: "accept" })),
    }));
    expect(r?.status).toBe(502);
  });
});


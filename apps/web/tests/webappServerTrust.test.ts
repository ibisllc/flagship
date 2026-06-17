// isServerTrusted foundation (lib/serverTrust.js) + the .com chokepoint
// (lib/comFetch.js). Verifies: the no-verdict-vs-untrusted distinction, the
// network-error-is-not-a-verdict rule, the override→calls-resume behaviour,
// the baked-pin lockstep with the protocol source, and that comFetch
// short-circuits while untrusted but lets the blessing probe through.

import { describe, expect, it, beforeEach } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TRUST_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/serverTrust.js"),
).href;
const COMFETCH_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/comFetch.js"),
).href;

const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/maintainerTrust.webapp.vectors.json"), "utf8"),
);
const NOW_MS = Date.parse(VECTORS.clientNow);

async function loadTrust() {
  return import(TRUST_URL);
}
async function loadComFetch() {
  return import(COMFETCH_URL);
}

function blessingOf(name: string) {
  const c = VECTORS.cases.find((x: { name: string }) => x.name === name);
  return c.blessing;
}

function fakeBlessingFetch(body: unknown, ok = true) {
  return async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

describe("serverTrust — baked pin lockstep with protocol", () => {
  it("BAKED_PIN equals MAINTAINER_PINNED_MANDATE_HASH in packages/protocol", async () => {
    const t = await loadTrust();
    const src = readFileSync(
      resolve(__dirname, "../../../packages/protocol/src/maintainerCa.ts"),
      "utf8",
    );
    const m = src.match(/MAINTAINER_PINNED_MANDATE_HASH\s*=\s*"([0-9a-f]{64})"/);
    expect(m).not.toBeNull();
    expect(t.BAKED_PIN).toBe(m![1]);
  });
});

describe("serverTrust — verdict semantics", () => {
  beforeEach(async () => {
    (await loadTrust()).serverTrust._reset();
  });

  it("no verdict yet ⇒ trusted (don't brick before a verdict lands)", async () => {
    const t = await loadTrust();
    expect(t.serverTrust.verdict).toBeNull();
    expect(t.serverTrust.isServerTrusted()).toBe(true);
  });

  it("a valid trusted blessing ⇒ trusted, no failing certs", async () => {
    const t = await loadTrust();
    const r = await t.refreshServerTrust({
      fetchImpl: fakeBlessingFetch(blessingOf("trusted: served key is the live-authorized hot CA key")),
      now: () => NOW_MS,
      pin: VECTORS.pin,
    });
    expect(r.ok).toBe(true);
    expect(t.serverTrust.isServerTrusted()).toBe(true);
    expect(t.serverTrust.failingCerts()).toHaveLength(0);
  });

  it("a valid blessing that fails verification ⇒ untrusted with one failing cert", async () => {
    const t = await loadTrust();
    await t.refreshServerTrust({
      fetchImpl: fakeBlessingFetch(blessingOf("untrusted: served key is NOT the authorized key")),
      now: () => NOW_MS,
      pin: VECTORS.pin,
    });
    expect(t.serverTrust.isServerTrusted()).toBe(false);
    const certs = t.serverTrust.failingCerts();
    expect(certs).toHaveLength(1);
    expect(certs[0].certClass).toBe("control");
    expect(certs[0].certHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a network error is NOT a verdict — stays trusted, verdict null", async () => {
    const t = await loadTrust();
    const r = await t.refreshServerTrust({
      fetchImpl: async () => {
        throw new Error("offline");
      },
      now: () => NOW_MS,
      pin: VECTORS.pin,
    });
    expect(r.networkError).toBe(true);
    expect(t.serverTrust.verdict).toBeNull();
    expect(t.serverTrust.isServerTrusted()).toBe(true);
  });

  it("a 5xx is NOT a verdict either", async () => {
    const t = await loadTrust();
    const r = await t.refreshServerTrust({
      fetchImpl: fakeBlessingFetch(null, false),
      now: () => NOW_MS,
      pin: VECTORS.pin,
    });
    expect(r.networkError).toBe(true);
    expect(t.serverTrust.verdict).toBeNull();
  });

  it("override makes calls resume but the failing-cert line persists", async () => {
    const t = await loadTrust();
    await t.refreshServerTrust({
      fetchImpl: fakeBlessingFetch(blessingOf("untrusted: served key is NOT the authorized key")),
      now: () => NOW_MS,
      pin: VECTORS.pin,
    });
    const certHash = t.serverTrust.failingCerts()[0].certHash;
    expect(t.serverTrust.isServerTrusted()).toBe(false);

    t.serverTrust.markOverridden(certHash, { certHash });
    expect(t.serverTrust.isServerTrusted()).toBe(true); // calls resume
    // ...but the line stays visible, now flagged overridden.
    const certs = t.serverTrust.failingCerts();
    expect(certs).toHaveLength(1);
    expect(certs[0].overridden).toBe(true);
  });

  it("controlCertHash = sha256hex(utf8(caPubkey))", async () => {
    const t = await loadTrust();
    const { createHash } = await import("node:crypto");
    const pub = VECTORS.keys.hotCaPub;
    const expected = createHash("sha256").update(pub, "utf8").digest("hex");
    expect(await t.controlCertHash(pub)).toBe(expected);
  });
});

describe("comFetch — the .com chokepoint", () => {
  beforeEach(async () => {
    (await loadTrust()).serverTrust._reset();
  });

  it("comUrl prepends the apex to a path, passes an absolute URL through", async () => {
    const cf = await loadComFetch();
    expect(cf.comUrl("/api/foo")).toBe("https://flagshipserver.com/api/foo");
    expect(cf.comUrl("https://flagshipserver.com/api/bar")).toBe(
      "https://flagshipserver.com/api/bar",
    );
  });

  it("short-circuits a normal .com call while untrusted", async () => {
    const t = await loadTrust();
    const cf = await loadComFetch();
    await t.refreshServerTrust({
      fetchImpl: fakeBlessingFetch(blessingOf("untrusted: served key is NOT the authorized key")),
      now: () => NOW_MS,
      pin: VECTORS.pin,
    });
    let called = false;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(cf.comFetch("/api/users/x/pods")).rejects.toMatchObject({
      serverUntrusted: true,
    });
    expect(called).toBe(false);
  });

  it("lets the blessing probe through even while untrusted", async () => {
    const t = await loadTrust();
    const cf = await loadComFetch();
    await t.refreshServerTrust({
      fetchImpl: fakeBlessingFetch(blessingOf("untrusted: served key is NOT the authorized key")),
      now: () => NOW_MS,
      pin: VECTORS.pin,
    });
    let hit = "";
    (globalThis as { fetch: typeof fetch }).fetch = (async (u: string) => {
      hit = u;
      return new Response("{}");
    }) as typeof fetch;
    await cf.comFetch("/api/maintainer-blessing");
    expect(hit).toBe("https://flagshipserver.com/api/maintainer-blessing");
  });

  it("allows normal calls when trusted (or no verdict)", async () => {
    const cf = await loadComFetch();
    let hit = "";
    (globalThis as { fetch: typeof fetch }).fetch = (async (u: string) => {
      hit = u;
      return new Response("{}");
    }) as typeof fetch;
    await cf.comFetch("/api/users/x/pods"); // no verdict yet ⇒ trusted
    expect(hit).toBe("https://flagshipserver.com/api/users/x/pods");
  });
});

describe("comFetch — global fetch guard (the true chokepoint)", () => {
  beforeEach(async () => {
    (await loadTrust()).serverTrust._reset();
  });

  it("gates a RAW fetch to .com made by any lib while untrusted", async () => {
    const t = await loadTrust();
    const cf = await loadComFetch();
    let realHits = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      realHits++;
      return new Response("{}");
    }) as typeof fetch;
    cf.installComFetchGuard();
    try {
      await t.refreshServerTrust({
        fetchImpl: fakeBlessingFetch(blessingOf("untrusted: served key is NOT the authorized key")),
        now: () => NOW_MS,
        pin: VECTORS.pin,
      });
      // A raw fetch (as e.g. lib/leases.js does) is now intercepted.
      await expect(
        fetch("https://flagshipserver.com/api/server/x/unlock-key/leases"),
      ).rejects.toMatchObject({ serverUntrusted: true });
      // ...the blessing probe and non-.com hosts still pass through.
      await fetch("https://flagshipserver.com/api/maintainer-blessing");
      await fetch("https://x.user.flagship.services/api/health"); // pod host, not gated
      expect(realHits).toBe(2);
    } finally {
      cf.uninstallComFetchGuard();
    }
  });

  it("installing twice is idempotent and a no-verdict fetch passes", async () => {
    const cf = await loadComFetch();
    let realHits = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      realHits++;
      return new Response("{}");
    }) as typeof fetch;
    cf.installComFetchGuard();
    cf.installComFetchGuard();
    try {
      await fetch("https://flagshipserver.com/api/users/x/pods"); // no verdict ⇒ trusted
      expect(realHits).toBe(1);
    } finally {
      cf.uninstallComFetchGuard();
    }
  });
});

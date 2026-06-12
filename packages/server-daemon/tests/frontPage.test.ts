import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signPhoneOrder, type Keypair, type PhoneOrder } from "@flagship/protocol";
import { buildFrontPageHttp, FrontPageStore } from "../src/frontPage.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "az2.harry.flagship.services";
const NOW = 1_700_000_000_000;

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function tempStore(): FrontPageStore {
  return new FrontPageStore(join(mkdtempSync(join(tmpdir(), "fp-")), "front-page.json"));
}

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: { host: FQDN },
    body: Buffer.alloc(0),
    ...over,
  };
}

function setEnvelope(irk: Keypair, label: string, issuedAt = NOW): Buffer {
  const order: PhoneOrder = { type: "set-front-page", serverId: FQDN, label, issuedAt };
  const sig = signPhoneOrder(order, irk);
  return Buffer.from(JSON.stringify({ request: order, signature: hex(sig) }));
}

function build(irk: Keypair, store = tempStore(), installed = new Set(["photos", "blog"])) {
  return {
    handle: buildFrontPageHttp({
      serverId: FQDN,
      ownerIrkPub: irk.publicKey,
      store,
      resolveLabel: (l) => installed.has(l),
      now: () => NOW,
    }),
    store,
    installed,
  };
}

describe("FrontPageStore", () => {
  it("persists across instances and treats absent state as unassigned", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "fp-")), "front-page.json");
    const a = new FrontPageStore(path);
    await a.load();
    expect(a.get()).toBe(null);
    await a.set("photos");
    const b = new FrontPageStore(path);
    await b.load();
    expect(b.get()).toBe("photos");
    await b.set(null);
    const c = new FrontPageStore(path);
    await c.load();
    expect(c.get()).toBe(null);
  });
});

describe("POST /api/front-page (owner-IRK set)", () => {
  it("assigns on a valid IRK signature and persists", async () => {
    const irk = makeKey(7);
    const { handle, store } = build(irk);
    const r = await handle(req({ method: "POST", path: "/api/front-page", body: setEnvelope(irk, "photos") }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r!.body))).toEqual({ ok: true, label: "photos" });
    expect(store.get()).toBe("photos");
  });

  it("clears with an empty label", async () => {
    const irk = makeKey(7);
    const { handle, store } = build(irk);
    await handle(req({ method: "POST", path: "/api/front-page", body: setEnvelope(irk, "photos") }));
    const r = await handle(req({ method: "POST", path: "/api/front-page", body: setEnvelope(irk, "") }));
    expect(r?.status).toBe(200);
    expect(store.get()).toBe(null);
  });

  it("rejects a non-owner signature", async () => {
    const irk = makeKey(7);
    const { handle, store } = build(irk);
    const r = await handle(
      req({ method: "POST", path: "/api/front-page", body: setEnvelope(makeKey(8), "photos") }),
    );
    expect(r?.status).toBe(403);
    expect(store.get()).toBe(null);
  });

  it("rejects a stale issuedAt (replay window)", async () => {
    const irk = makeKey(7);
    const { handle } = build(irk);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/front-page",
        body: setEnvelope(irk, "photos", NOW - 6 * 60_000),
      }),
    );
    expect(r?.status).toBe(403);
  });

  it("rejects an uninstalled label with 422", async () => {
    const irk = makeKey(7);
    const { handle } = build(irk);
    const r = await handle(
      req({ method: "POST", path: "/api/front-page", body: setEnvelope(irk, "nosuch") }),
    );
    expect(r?.status).toBe(422);
  });

  it("rejects a non-DNS label shape", async () => {
    const irk = makeKey(7);
    const { handle } = build(irk);
    const order = { type: "set-front-page", serverId: FQDN, label: "Bad_Label", issuedAt: NOW };
    const body = Buffer.from(JSON.stringify({ request: order, signature: "00" }));
    const r = await handle(req({ method: "POST", path: "/api/front-page", body }));
    expect(r?.status).toBe(400);
  });

  it("rejects a serverId mismatch", async () => {
    const irk = makeKey(7);
    const { handle } = build(irk);
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: "other.harry.flagship.services",
      label: "photos",
      issuedAt: NOW,
    };
    const sig = signPhoneOrder(order, irk);
    const body = Buffer.from(JSON.stringify({ request: order, signature: hex(sig) }));
    const r = await handle(req({ method: "POST", path: "/api/front-page", body }));
    expect(r?.status).toBe(403);
  });
});

describe("GET /api/front-page", () => {
  it("reports the assignment and whether it currently resolves", async () => {
    const irk = makeKey(7);
    const { handle, installed } = build(irk);
    await handle(req({ method: "POST", path: "/api/front-page", body: setEnvelope(irk, "photos") }));
    let r = await handle(req({ method: "GET", path: "/api/front-page" }));
    expect(JSON.parse(String(r!.body))).toEqual({ label: "photos", active: true });
    installed.delete("photos");
    r = await handle(req({ method: "GET", path: "/api/front-page" }));
    expect(JSON.parse(String(r!.body))).toEqual({ label: "photos", active: false });
  });
});

describe("apex redirect", () => {
  async function assigned() {
    const irk = makeKey(7);
    const built = build(irk);
    await built.handle(
      req({ method: "POST", path: "/api/front-page", body: setEnvelope(irk, "photos") }),
    );
    return built;
  }

  it("302s the apex to the service's tier-1 canonical, uncacheable", async () => {
    const { handle } = await assigned();
    const r = await handle(req({ path: "/" }));
    expect(r?.status).toBe(302);
    expect(r?.headers?.location).toBe(`https://photos.${FQDN}/`);
    expect(r?.headers?.["cache-control"]).toBe("no-store");
  });

  it("falls through (default page) when unassigned", async () => {
    const irk = makeKey(7);
    const { handle } = build(irk);
    expect(await handle(req({ path: "/" }))).toBe(null);
  });

  it("falls back to the default page when the assigned service is gone", async () => {
    const { handle, installed } = await assigned();
    installed.delete("photos");
    expect(await handle(req({ path: "/" }))).toBe(null);
  });

  it("only redirects the apex host — not LAN IPs or stray hosts", async () => {
    const { handle } = await assigned();
    expect(await handle(req({ path: "/", headers: { host: "10.10.3.142" } }))).toBe(null);
    expect(await handle(req({ path: "/", headers: { host: `x.${FQDN}` } }))).toBe(null);
    // Port suffix on the apex host still matches.
    const r = await handle(req({ path: "/", headers: { host: `${FQDN}:443` } }));
    expect(r?.status).toBe(302);
  });

  it("never touches API paths or non-GET methods", async () => {
    const { handle } = await assigned();
    expect(await handle(req({ path: "/api/power" }))).toBe(null);
    expect(await handle(req({ method: "POST", path: "/" }))).toBe(null);
  });
});

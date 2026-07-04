/**
 * The per-app (SNI-routed `<urlLabel>.<serverFqdn>`) proxy path must be
 * fronted by the service-access gates. This composition was MISSING live:
 * `buildAccessEnforcementHandler` was only registered on the daemon's own
 * handler chain, which the app path never runs — so a `restricted` service
 * still served 200 to anonymous traffic on a real box (caught by the live
 * gating e2e, gym-results/gating-live-2026-07-04T08-57-30-116Z).
 *
 * These tests compose the REAL gates exactly as index.ts wires them —
 * `buildGatedAppHandler([accessWeb.handle, enforcement], proxyToApp)` — and
 * pin the live behaviors: open falls through, restricted knocks a browser /
 * 403s an API client, the knock page's SAME-ORIGIN status poll is answered
 * by the gate (never proxied), and a valid session cookie reaches the app.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveAccountId } from "@flagship/protocol";
import {
  decideServiceAccess,
  ServiceAccessStore,
  ServiceSessionStore,
  SESSION_COOKIE,
  buildAccessEnforcementHandler,
} from "../src/serviceAccess.js";
import { buildServiceAccessWeb } from "../src/serviceAccessWeb.js";
import { buildGatedAppHandler, type HttpRequest, type HttpResponse } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const SERVICE = "alice--gate";
const LABEL = "gate";
const NOW = 1_700_000_000_000;
const friendAid = deriveAccountId({ seed: new Uint8Array(32).fill(22) });
const friendAidHex = [...friendAid.publicKey].map((x) => x.toString(16).padStart(2, "0")).join("");

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: { host: `${LABEL}.${FQDN}`, accept: "text/html" },
    body: Buffer.alloc(0),
    ...over,
  };
}

async function harness(mode: "open" | "restricted") {
  const store = new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "age-")), "sa.json"));
  await store.load();
  await store.setMode(SERVICE, mode);
  await store.addAllowed(SERVICE, friendAidHex);
  const sessions = new ServiceSessionStore(join(mkdtempSync(join(tmpdir(), "age-")), "ss.json"));
  await sessions.load();
  const accessWeb = buildServiceAccessWeb({ serverId: FQDN, store, sessions, now: () => NOW });
  // Mirrors index.ts: resolve the host's leftmost label to the installed
  // serviceId, knock via accessWeb.
  const enforcement = buildAccessEnforcementHandler(
    {
      store,
      decide: (ref, r) => decideServiceAccess({ serverId: FQDN, store, sessions, now: () => NOW }, ref, r),
    },
    (r) => {
      const host = (r.headers.host ?? "").split(":")[0]!.toLowerCase();
      const suffix = `.${FQDN.toLowerCase()}`;
      if (!host.endsWith(suffix) || host.length === suffix.length) return null;
      const label = host.slice(0, host.length - suffix.length);
      if (label.includes(".")) return null;
      return label === LABEL ? SERVICE : null;
    },
    accessWeb.maybeServeKnock,
  );
  let proxied = 0;
  const app = async (): Promise<HttpResponse> => {
    proxied++;
    return { status: 200, headers: { "content-type": "text/plain" }, body: "app content" };
  };
  const handler = buildGatedAppHandler([accessWeb.handle, enforcement], app);
  return { handler, sessions, wasProxied: () => proxied };
}

describe("per-app proxy path is fronted by the service-access gates", () => {
  it("OPEN service: the gates fall through and the app serves", async () => {
    const { handler, wasProxied } = await harness("open");
    const r = await handler(req({}));
    expect(r.status).toBe(200);
    expect(String(r.body)).toBe("app content");
    expect(wasProxied()).toBe(1);
  });

  it("RESTRICTED: a browser nav gets the knock page — the app is NEVER reached", async () => {
    const { handler, wasProxied } = await harness("restricted");
    const r = await handler(req({}));
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain("Access is restricted");
    expect(wasProxied()).toBe(0);
  });

  it("RESTRICTED: a non-browser request gets 403 JSON — the app is NEVER reached", async () => {
    const { handler, wasProxied } = await harness("restricted");
    const r = await handler(req({ headers: { host: `${LABEL}.${FQDN}`, accept: "application/json" } }));
    expect(r.status).toBe(403);
    expect(JSON.parse(String(r.body)).error).toBe("access restricted");
    expect(wasProxied()).toBe(0);
  });

  it("the knock page's SAME-ORIGIN status poll is answered by the gate, not proxied", async () => {
    const { handler, wasProxied } = await harness("restricted");
    const knock = await handler(req({}));
    const pageId = (/[?&]page=([0-9a-f]+)/.exec(String(knock.body)) || [])[1];
    expect(pageId).toBeTruthy();
    const poll = await handler(
      req({ path: `/__flagship/knock/${pageId}/status`, headers: { host: `${LABEL}.${FQDN}`, accept: "application/json" } }),
    );
    expect(poll.status).toBe(200);
    expect(JSON.parse(String(poll.body)).status).toBe("pending");
    expect(wasProxied()).toBe(0);
  });

  it("RESTRICTED: a live session cookie for an allow-listed AID reaches the app", async () => {
    const { handler, sessions, wasProxied } = await harness("restricted");
    const token = await sessions.issue(SERVICE, friendAidHex, NOW, 60_000);
    const r = await handler(
      req({ headers: { host: `${LABEL}.${FQDN}`, accept: "text/html", cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(r.status).toBe(200);
    expect(String(r.body)).toBe("app content");
    expect(wasProxied()).toBe(1);
  });

  it("an unknown label (not an installed service) falls through to the app handler", async () => {
    const { handler, wasProxied } = await harness("restricted");
    const r = await handler(req({ headers: { host: `other.${FQDN}`, accept: "text/html" } }));
    expect(r.status).toBe(200);
    expect(wasProxied()).toBe(1);
  });
});

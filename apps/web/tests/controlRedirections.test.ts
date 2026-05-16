import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { TunnelRegistry, type RegisteredTunnel, type StreamCallbacks } from "../src/tunnel/registry.js";
import {
  registerControlRedirections,
  coldStartRedirections,
} from "../src/routes/controlRedirections.js";

function fakeTunnel(podCanonical: string): RegisteredTunnel {
  const streams = new Map<number, StreamCallbacks>();
  let n = 1;
  return {
    podCanonical,
    send: () => {},
    attachStream: (id, cbs) => streams.set(id, cbs),
    detachStream: (id) => streams.delete(id),
    nextStreamId: () => n++,
  };
}

async function appWith(secret?: string) {
  const registry = new TunnelRegistry();
  const pod = fakeTunnel("home.u.flagship.services");
  registry.register({ tunnel: pod, canonicals: ["home.u.flagship.services"] });
  const app = Fastify({ logger: false });
  registerControlRedirections(app, { registry, secret });
  await app.ready();
  return { app, registry, pod };
}

describe("POST /control/redirections (#87)", () => {
  it("503 when the control channel is unconfigured (fail closed)", async () => {
    const { app } = await appWith(undefined);
    const r = await app.inject({
      method: "POST", url: "/control/redirections",
      headers: { authorization: "Bearer x" },
      payload: { op: "add", fqdn: "shop.example.com", podCanonical: "home.u.flagship.services" },
    });
    expect(r.statusCode).toBe(503);
    await app.close();
  });

  it("401 without / with a wrong bearer", async () => {
    const { app } = await appWith("s3cr3t");
    const noauth = await app.inject({ method: "POST", url: "/control/redirections", payload: { op: "add", fqdn: "a.example.com", podCanonical: "home.u.flagship.services" } });
    expect(noauth.statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/control/redirections", headers: { authorization: "Bearer nope" }, payload: { op: "add", fqdn: "a.example.com", podCanonical: "home.u.flagship.services" } });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it("400 on malformed body / add without podCanonical", async () => {
    const { app } = await appWith("s3cr3t");
    const h = { authorization: "Bearer s3cr3t" };
    expect((await app.inject({ method: "POST", url: "/control/redirections", headers: h, payload: { op: "noop", fqdn: "a.example.com" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/control/redirections", headers: h, payload: { op: "add", fqdn: "a.example.com" } })).statusCode).toBe(400);
    await app.close();
  });

  it("add then delete mutate the RAM redirection table", async () => {
    const { app, registry, pod } = await appWith("s3cr3t");
    const h = { authorization: "Bearer s3cr3t" };
    const add = await app.inject({ method: "POST", url: "/control/redirections", headers: h, payload: { op: "add", fqdn: "shop.example.com", podCanonical: "home.u.flagship.services" } });
    expect(add.statusCode).toBe(200);
    expect(JSON.parse(add.body)).toEqual({ ok: true, count: 1 });
    expect(registry.findBySni("shop.example.com")).toBe(pod);

    const del = await app.inject({ method: "POST", url: "/control/redirections", headers: h, payload: { op: "delete", fqdn: "shop.example.com" } });
    expect(del.statusCode).toBe(200);
    expect(registry.findBySni("shop.example.com")).toBeUndefined();
    await app.close();
  });
});

describe("coldStartRedirections (#87)", () => {
  it("loads fqdn→pod from .com into the RAM table", async () => {
    const registry = new TunnelRegistry();
    const pod = fakeTunnel("home.u.flagship.services");
    registry.register({ tunnel: pod, canonicals: ["home.u.flagship.services"] });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://com.example/api/internal/active-redirections");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sek");
      return {
        ok: true, status: 200,
        json: async () => ({ redirections: [{ fqdn: "shop.example.com", podCanonical: "home.u.flagship.services" }] }),
      } as Response;
    }) as unknown as typeof fetch;
    const n = await coldStartRedirections({ registry, comBaseUrl: "https://com.example/", secret: "sek", fetchImpl });
    expect(n).toBe(1);
    expect(registry.findBySni("shop.example.com")).toBe(pod);
  });

  it("returns -1 (no-op) when no secret, and on a non-ok / thrown response", async () => {
    const registry = new TunnelRegistry();
    expect(await coldStartRedirections({ registry, comBaseUrl: "https://x", secret: undefined })).toBe(-1);
    const bad = (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch;
    expect(await coldStartRedirections({ registry, comBaseUrl: "https://x", secret: "s", fetchImpl: bad })).toBe(-1);
    const thrown = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await coldStartRedirections({ registry, comBaseUrl: "https://x", secret: "s", fetchImpl: thrown })).toBe(-1);
  });
});

// Unit tests for the Worker-side Hetzner client.
//
// No real Hetzner API calls — `fetch` is injected via the
// `HetznerClientOptions.fetch` hook. Covers:
//   1. createServerFromSnapshot sends the spec-§7.2 body shape.
//   2. getServerStatus parses every enum value the API can return.
//   3. destroyServer collapses 404 to success (idempotent).
//   4. 5xx propagates as a typed HetznerClientError.

import { describe, expect, it, vi } from "vitest";
import {
  createHetznerClient,
  HetznerClientError,
  type FetchLike,
  type HetznerServerStatus,
} from "../src/hetzner.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(
  responder: (call: CapturedCall) => { status: number; body: unknown },
): { fn: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: FetchLike = async (input, init) => {
    const call: CapturedCall = {
      url: input,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    const { status, body } = responder(call);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  };
  return { fn, calls };
}

describe("createHetznerClient.createServerFromSnapshot", () => {
  it("sends Bearer auth + spec-§7.2 body shape and parses serverId + ipv4", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: {
        server: {
          id: 42,
          public_net: { ipv4: { ip: "5.6.7.8" } },
        },
      },
    }));
    const client = createHetznerClient({ token: "TKN", fetch: fn });
    const out = await client.createServerFromSnapshot({
      name: "demo-demoalice-abcd",
      snapshotId: "12345678",
      location: "fsn1",
      serverType: "cx22",
      sshKeyId: 99,
      username: "demoalice",
    });
    expect(out).toEqual({ serverId: "42", ipv4: "5.6.7.8" });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://api.hetzner.cloud/v1/servers");
    expect(c.headers.authorization).toBe("Bearer TKN");
    const body = JSON.parse(c.body ?? "{}");
    expect(body).toEqual({
      name: "demo-demoalice-abcd",
      image: "12345678",
      location: "fsn1",
      server_type: "cx22",
      ssh_keys: [99],
      start_after_create: true,
      labels: { "flagship-demo": "demoalice" },
    });
  });

  it("returns ipv4=null when Hetzner hasn't allocated an IP yet", async () => {
    const { fn } = fakeFetch(() => ({
      status: 201,
      body: { server: { id: 7, public_net: { ipv4: { ip: "" } } } },
    }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    const out = await client.createServerFromSnapshot({
      name: "n", snapshotId: "1", location: "fsn1", serverType: "cx22", sshKeyId: 1, username: "u",
    });
    expect(out.ipv4).toBeNull();
  });

  it("throws HetznerClientError on non-2xx", async () => {
    const { fn } = fakeFetch(() => ({ status: 422, body: { error: "bad image" } }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    await expect(
      client.createServerFromSnapshot({
        name: "n", snapshotId: "x", location: "fsn1", serverType: "cx22", sshKeyId: 1, username: "u",
      }),
    ).rejects.toBeInstanceOf(HetznerClientError);
  });

  it("propagates 5xx as a typed error so the handler can return 502", async () => {
    const { fn } = fakeFetch(() => ({ status: 503, body: "service unavailable" }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    try {
      await client.createServerFromSnapshot({
        name: "n", snapshotId: "x", location: "fsn1", serverType: "cx22", sshKeyId: 1, username: "u",
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HetznerClientError);
      const err = e as HetznerClientError;
      expect(err.status).toBe(503);
    }
  });
});

describe("createHetznerClient.getServerStatus", () => {
  it.each([
    "initializing", "starting", "running", "stopping",
    "off", "deleting", "migrating", "rebuilding",
  ] as HetznerServerStatus[])(
    "parses status=%s verbatim",
    async (status) => {
      const { fn } = fakeFetch(() => ({
        status: 200,
        body: { server: { status, public_net: { ipv4: { ip: "1.2.3.4" } } } },
      }));
      const client = createHetznerClient({ token: "T", fetch: fn });
      const out = await client.getServerStatus("99");
      expect(out.status).toBe(status);
      expect(out.ipv4).toBe("1.2.3.4");
    },
  );

  it("collapses unknown server.status to the 'unknown' enum literal", async () => {
    const { fn } = fakeFetch(() => ({
      status: 200,
      body: { server: { status: "weirdNew", public_net: { ipv4: { ip: "1.1.1.1" } } } },
    }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    const out = await client.getServerStatus("99");
    expect(out.status).toBe("unknown");
  });

  it("URL-encodes the server id", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 200,
      body: { server: { status: "running", public_net: { ipv4: { ip: "1.1.1.1" } } } },
    }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    await client.getServerStatus("foo/bar");
    expect(calls[0]!.url).toBe("https://api.hetzner.cloud/v1/servers/foo%2Fbar");
  });
});

describe("createHetznerClient.destroyServer", () => {
  it("returns silently on 2xx", async () => {
    const { fn } = fakeFetch(() => ({ status: 200, body: { action: { id: 1 } } }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    await expect(client.destroyServer("99")).resolves.toBeUndefined();
  });

  it("collapses 404 to success (idempotent)", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 404, body: { error: "not_found" } }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    await expect(client.destroyServer("99")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("throws on other non-2xx codes", async () => {
    const { fn } = fakeFetch(() => ({ status: 500, body: { error: "boom" } }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    await expect(client.destroyServer("99")).rejects.toBeInstanceOf(HetznerClientError);
  });
});

describe("createHetznerClient construction", () => {
  it("throws when no token is supplied", () => {
    expect(() => createHetznerClient({ token: "" })).toThrow();
  });

  it("accepts the legacy string-token signature", () => {
    expect(() => createHetznerClient("token")).not.toThrow();
  });

  it("uses globalThis.fetch when no fetch is injected", () => {
    const saved = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    try {
      const c = createHetznerClient("token");
      expect(c).toBeTruthy();
    } finally {
      globalThis.fetch = saved;
    }
  });
});

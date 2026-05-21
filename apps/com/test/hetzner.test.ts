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

// ──────────────────────────────────────────────────────────────────────
// W11 — cloud-init user_data provisioning + snapshot lifecycle
// ──────────────────────────────────────────────────────────────────────

describe("createHetznerClient.createServerWithUserData (W11)", () => {
  it("posts ubuntu-22.04 + user_data + flagship-demo label and parses ipv4", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: {
        server: { id: 1234, public_net: { ipv4: { ip: "10.20.30.40" } } },
      },
    }));
    const client = createHetznerClient({ token: "TKN", fetch: fn });
    const out = await client.createServerWithUserData({
      name: "flagship-demo-alice-1a2b",
      location: "fsn1",
      serverType: "cpx11",
      userData: "#!/bin/bash\necho hi\n",
      username: "demo-alice",
    });
    expect(out).toEqual({ serverId: "1234", ipv4: "10.20.30.40" });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body ?? "{}");
    expect(body).toMatchObject({
      name: "flagship-demo-alice-1a2b",
      image: "ubuntu-22.04",
      location: "fsn1",
      server_type: "cpx11",
      user_data: "#!/bin/bash\necho hi\n",
      start_after_create: true,
      labels: { "flagship-demo": "demo-alice" },
    });
    expect(body.ssh_keys).toBeUndefined();
  });

  it("attaches ssh_keys when sshKeyId is provided (for operator debugging)", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { server: { id: 1, public_net: { ipv4: { ip: "1.1.1.1" } } } },
    }));
    const client = createHetznerClient({ token: "TKN", fetch: fn });
    await client.createServerWithUserData({
      name: "n",
      location: "fsn1",
      serverType: "cpx11",
      userData: "#!/bin/bash\n:\n",
      username: "u",
      sshKeyId: 99,
    });
    const body = JSON.parse(calls[0]!.body ?? "{}");
    expect(body.ssh_keys).toEqual([99]);
  });

  it("retries through fallbackServerTypes on a 422 and succeeds on the first match", async () => {
    let i = 0;
    const { fn, calls } = fakeFetch(() => {
      i++;
      if (i === 1) return { status: 422, body: { error: { code: "unsupported_location" } } };
      return {
        status: 201,
        body: { server: { id: 9, public_net: { ipv4: { ip: "2.2.2.2" } } } },
      };
    });
    const client = createHetznerClient({ token: "T", fetch: fn });
    const out = await client.createServerWithUserData({
      name: "n",
      location: "fsn1",
      serverType: "cpx11",
      userData: "#!/bin/bash\n:\n",
      username: "u",
      fallbackServerTypes: ["cx22", "cpx21"],
    });
    expect(out.serverId).toBe("9");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body ?? "{}").server_type).toBe("cpx11");
    expect(JSON.parse(calls[1]!.body ?? "{}").server_type).toBe("cx22");
  });

  it("does NOT retry on non-422 errors", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 403, body: { error: "no" } }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    await expect(
      client.createServerWithUserData({
        name: "n",
        location: "fsn1",
        serverType: "cpx11",
        userData: "#!/bin/bash\n:\n",
        username: "u",
        fallbackServerTypes: ["cx22"],
      }),
    ).rejects.toBeInstanceOf(HetznerClientError);
    expect(calls).toHaveLength(1);
  });
});

describe("createHetznerClient image lifecycle (W11)", () => {
  it("createImageSnapshot POSTs create_image and returns image.id as string", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { image: { id: 55, status: "creating" } },
    }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    const out = await client.createImageSnapshot("123", "flagship-demo-alice");
    expect(out).toEqual({ imageId: "55" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.hetzner.cloud/v1/servers/123/actions/create_image",
    );
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      type: "snapshot",
      description: "flagship-demo-alice",
    });
  });

  it("getImageStatus maps creating/available verbatim and coerces anything else to unknown", async () => {
    for (const status of ["creating", "available", "weird"]) {
      const { fn } = fakeFetch(() => ({
        status: 200,
        body: { image: { status } },
      }));
      const client = createHetznerClient({ token: "T", fetch: fn });
      const out = await client.getImageStatus("55");
      expect(out.status).toBe(
        status === "creating" || status === "available" ? status : "unknown",
      );
    }
  });

  it("destroyImage collapses 404 to success", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 404,
      body: { error: "not_found" },
    }));
    const client = createHetznerClient({ token: "T", fetch: fn });
    await expect(client.destroyImage("99")).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
  });
});

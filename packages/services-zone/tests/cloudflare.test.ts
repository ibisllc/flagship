import { describe, expect, it } from "vitest";
import { CloudflareZoneApi } from "../src/cloudflare.js";
import type { FetchLike } from "../src/types.js";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeCloudflare(reply: { ok?: boolean; status?: number; data: unknown }): {
  f: FetchLike;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const ok = reply.ok ?? true;
    const status = reply.status ?? 200;
    return {
      ok,
      status,
      async text() {
        return JSON.stringify(reply.data);
      },
      async json() {
        return reply.data;
      },
    };
  };
  return { f, calls };
}

describe("CloudflareZoneApi", () => {
  it("createTxt POSTs to /zones/<id>/dns_records with bearer auth and returns the record id", async () => {
    const { f, calls } = fakeCloudflare({
      data: {
        success: true,
        result: { id: "rec-1", name: "_acme-challenge.harry.flagship.services", content: "v" },
      },
    });
    const api = new CloudflareZoneApi({
      zoneId: "zoneABC",
      apiToken: "tk",
      fetchImpl: f,
    });
    const r = await api.createTxt({ name: "_acme-challenge.harry.flagship.services", value: "v" });
    expect(r.id).toBe("rec-1");
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://api.cloudflare.com/client/v4/zones/zoneABC/dns_records");
    expect(c.headers.authorization).toBe("Bearer tk");
    expect(c.body).toMatchObject({
      type: "TXT",
      name: "_acme-challenge.harry.flagship.services",
      content: "v",
      ttl: 60,
    });
  });

  it("throws when Cloudflare returns success:false (with the formatted error code)", async () => {
    const { f } = fakeCloudflare({
      data: {
        success: false,
        errors: [{ code: 81057, message: "Record already exists" }],
        result: null,
      },
    });
    const api = new CloudflareZoneApi({ zoneId: "z", apiToken: "tk", fetchImpl: f });
    await expect(
      api.createTxt({ name: "_acme-challenge.x", value: "v" }),
    ).rejects.toThrow(/81057.*already exists/);
  });

  it("deleteTxt issues a DELETE", async () => {
    const { f, calls } = fakeCloudflare({ data: { success: true, result: { id: "rec-1" } } });
    const api = new CloudflareZoneApi({ zoneId: "z", apiToken: "tk", fetchImpl: f });
    await api.deleteTxt("rec-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/dns_records/rec-1");
  });

  it("listTxtByName issues a GET with a name filter and maps the response", async () => {
    const { f, calls } = fakeCloudflare({
      data: {
        success: true,
        result: [{ id: "a", name: "x", content: "v1" }, { id: "b", name: "x", content: "v2" }],
      },
    });
    const api = new CloudflareZoneApi({ zoneId: "z", apiToken: "tk", fetchImpl: f });
    const out = await api.listTxtByName("_acme-challenge.harry.flagship.services");
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("type=TXT");
  });
});

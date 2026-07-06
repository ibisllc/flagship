import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareDnsClient } from "../src/cloudflareDns.js";

/**
 * createTxt idempotency against Cloudflare 81058 ("An identical record already
 * exists"). For ACME DNS-01 the invariant is that a TXT at `name` carrying
 * `value` is present; a daemon restart or issuance retry re-publishes the same
 * challenge value before the prior record is swept, and a non-idempotent create
 * would then wedge issuance forever. Surfaced live standing up the gym box.
 */
describe("CloudflareDnsClient.createTxt idempotency", () => {
  afterEach(() => vi.unstubAllGlobals());

  const cfg = { apiToken: "t", zoneId: "z" };
  const NAME = "_acme-challenge.home.gymbox.gym.flagship.services";
  const VALUE = "mBnSk-MVOrwOoUhCQp6T7Eatl_O_-E_eN6HpJYoIn1c";
  const EXISTING = {
    id: "cf-rec-1",
    type: "TXT",
    name: NAME,
    content: VALUE,
    proxied: false,
    ttl: 60,
  };

  it("resolves to the existing record when CF replies 81058", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if ((init?.method ?? "GET") === "POST") {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 81058, message: "An identical record already exists." }] }),
          { status: 400 },
        );
      }
      // the follow-up list() lookup
      return new Response(JSON.stringify({ success: true, result: [EXISTING] }), { status: 200 });
    });

    const dns = new CloudflareDnsClient(cfg);
    const rec = await dns.createTxt({ name: NAME, value: VALUE });
    expect(rec.id).toBe("cf-rec-1");
    expect(rec.content).toBe(VALUE);
    // It POSTed (got 81058) then LISTed to recover the existing record.
    expect(calls.some((c) => c.startsWith("POST"))).toBe(true);
    expect(calls.some((c) => c.startsWith("GET"))).toBe(true);
  });

  it("still throws on a non-81058 create failure", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1004, message: "DNS validation error" }] }), {
        status: 400,
      }),
    );
    const dns = new CloudflareDnsClient(cfg);
    await expect(dns.createTxt({ name: NAME, value: VALUE })).rejects.toThrow(/createTxt failed/);
  });

  it("throws on 81058 when the existing record can't be recovered (different value)", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: { method?: string }) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 81058 }] }), { status: 400 });
      }
      // list() returns a record with a DIFFERENT content → no match → throw
      return new Response(
        JSON.stringify({ success: true, result: [{ ...EXISTING, content: "some-other-value" }] }),
        { status: 200 },
      );
    });
    const dns = new CloudflareDnsClient(cfg);
    await expect(dns.createTxt({ name: NAME, value: VALUE })).rejects.toThrow(/createTxt failed/);
  });
});

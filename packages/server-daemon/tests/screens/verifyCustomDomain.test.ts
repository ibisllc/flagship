import { describe, expect, it } from "vitest";
import {
  buildScreensHttp,
  type ScreensHttpDeps,
} from "../../src/screens/screensHttp.js";
import {
  expectedTxtToken,
  type DnsResolver,
} from "../../src/screens/verifyCustomDomain.js";
import type { VerifyCustomDomainResponse } from "../../src/screens/types.js";
import type { HttpRequest } from "../../src/runtime.js";

const SERVER_FQDN = "home.alice.flagship.services";

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "POST", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
}

function gate(token = "tok-good") {
  return {
    has(t: string) { return t === token; },
    check(r: HttpRequest) {
      return r.headers["x-flagship-session"] === token
        ? null
        : { status: 401, headers: {}, body: "{}" };
    },
  };
}

const COMMON: Omit<ScreensHttpDeps, "gate"> = {
  serverFqdn: SERVER_FQDN,
  username: "alice",
  daemonVersion: "0.0.1-test",
  startedAt: 1_000,
  now: () => 5_000,
};

function fixedResolver(records: Record<string, string[]>): DnsResolver {
  return {
    async resolveTxt(host: string) {
      return records[host] ?? [];
    },
  };
}

function postReq(body: unknown): HttpRequest {
  return req({
    method: "POST",
    path: "/api/screens/url-controller/verify",
    headers: { "x-flagship-session": "tok-good" },
    body: Buffer.from(JSON.stringify(body)),
  });
}

describe("screens HTTP — P1.22 url-controller/verify", () => {
  it("returns pending when no matching TXT record is present", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      dnsResolver: fixedResolver({}),
    });
    const r = await handle(postReq({ fqdn: "app.mydomain.com" }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as VerifyCustomDomainResponse;
    expect(body.status).toBe("pending");
    expect(body.expectedTxtRecord.startsWith("flagship-verify=")).toBe(true);
    expect(body.observedTxtRecord).toBeUndefined();
    expect(body.reason).toMatch(/DNS propagation/);
  });

  it("returns verified when the expected token is published", async () => {
    const fqdn = "app.mydomain.com";
    const token = expectedTxtToken(SERVER_FQDN, fqdn);
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      dnsResolver: fixedResolver({
        [`_flagship.${fqdn}`]: [token],
      }),
    });
    const r = await handle(postReq({ fqdn }));
    const body = JSON.parse(r!.body as string) as VerifyCustomDomainResponse;
    expect(body.status).toBe("verified");
    expect(body.observedTxtRecord).toBe(token);
    expect(body.reason).toBeUndefined();
  });

  it("returns pending with a mismatch reason when TXT is present but wrong", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      dnsResolver: fixedResolver({
        "_flagship.app.mydomain.com": ["flagship-verify=stale-token"],
      }),
    });
    const r = await handle(postReq({ fqdn: "app.mydomain.com" }));
    const body = JSON.parse(r!.body as string) as VerifyCustomDomainResponse;
    expect(body.status).toBe("pending");
    expect(body.observedTxtRecord).toBe("flagship-verify=stale-token");
    expect(body.reason).toMatch(/doesn't match/);
  });

  it("returns failed when DNS lookup throws", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      dnsResolver: {
        async resolveTxt() {
          throw new Error("DoH 503");
        },
      },
    });
    const r = await handle(postReq({ fqdn: "app.mydomain.com" }));
    const body = JSON.parse(r!.body as string) as VerifyCustomDomainResponse;
    expect(body.status).toBe("failed");
    expect(body.reason).toMatch(/DNS lookup failed/);
  });

  it("returns 400 when fqdn is missing", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      dnsResolver: fixedResolver({}),
    });
    const r = await handle(postReq({}));
    expect(r?.status).toBe(400);
  });

  it("expected token is stable per (serverFqdn, fqdn) pair", () => {
    const a = expectedTxtToken(SERVER_FQDN, "app.example.com");
    const b = expectedTxtToken(SERVER_FQDN, "app.example.com");
    const c = expectedTxtToken(SERVER_FQDN, "other.example.com");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("expected token differs across server FQDNs (so two pods can't collide)", () => {
    const a = expectedTxtToken("home.alice.flagship.services", "app.example.com");
    const b = expectedTxtToken("office.alice.flagship.services", "app.example.com");
    expect(a).not.toBe(b);
  });
});

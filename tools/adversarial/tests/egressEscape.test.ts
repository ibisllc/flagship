/**
 * V01 adversarial integration: egress and app-browser escape (SEC N02, SEC-BROWSER-002, N12).
 *
 * Every test attacks one boundary a sandboxed app, a build, the AI or an app's browser must not
 * cross to reach this server, its loopback services, the LAN or cloud metadata, and names the
 * finding it would catch.
 *
 *   AT-EGR-01  byte-level address classifier: every non-canonical spelling of an internal address
 *   AT-EGR-02  non-canonical IPv4 literals are never "public" (the strict parser refuses them)
 *   AT-EGR-03  egress gateway: an allowed NAME that resolves internal is never dialed
 *   AT-EGR-04  egress gateway: IP literals and junk in SNI/Host never pass the policy
 *   AT-EGR-05  access-list wildcards stop at DNS label boundaries
 *   AT-EGR-06  HTTP proxy: duplicate Host, a non-80 port in Host, or no Host is refused
 *   AT-EGR-07  app browser judge: numeric URL spellings, rebinding answers, private space
 *   AT-EGR-08  app browser judge: the server's own name with a trailing dot (was a finding; fixed)
 *   AT-EGR-09  app browser: production wiring tells the judge this server's names (was a finding; fixed)
 *   AT-EGR-10  per-app pinning proxy: one app's approval never opens a host to another app
 *   AT-EGR-11  pinning proxy: an approved host is reachable only on the approved port (was a finding; fixed)
 *   AT-EGR-12  AI provider fetch: redirects drop credentials, never reach internal space
 *   AT-EGR-13  git clone: no redirects, no protocols but http(s), pinned addresses, empty env
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAddress, isPublicAddress, decideAccess as decideAppAccess, checkAccessTarget } from "../../../packages/protocol/src/index.js";
import { decide, hostMatches, normalizeHost, type EgressPolicyState } from "../../../packages/server-daemon/src/egress/policy.js";
import { parseHttpHost, startProxyServer } from "../../../packages/server-daemon/src/egress/proxy.js";
import { BrowserGrants, BrowserJudge, type BrowserGrantRequest } from "../../../packages/server-daemon/src/browser/policy/index.js";
import { ServiceProxies } from "../../../packages/server-daemon/src/browser/egress.js";
import { guardedFetch, UnsafeBaseUrlError } from "../../../packages/llm-providers/src/index.js";
import { GIT_CLONE_ENV, hardenedGitConfig } from "../../../packages/server-daemon/src/buildmodes/gitImport.js";

const ROOT = join(import.meta.dirname, "../../..");

describe("address classification (SEC N02)", () => {
  it("AT-EGR-01 classifier: every spelling of loopback, metadata, link-local, ULA, NAT64, 6to4, Teredo and v4-mapped is non-public (catches: a dialer judging a spelling instead of the bytes)", () => {
    const cases: Array<[string, string]> = [
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"],
      ["::1", "loopback"],
      ["0:0:0:0:0:0:0:1", "loopback"],
      ["::ffff:127.0.0.1", "loopback"],
      ["::FFFF:127.0.0.1", "loopback"],
      ["::ffff:7f00:1", "loopback"],
      ["[::ffff:7f00:1]", "loopback"],
      ["169.254.169.254", "metadata"],
      ["::ffff:169.254.169.254", "metadata"],
      ["0:0:0:0:0:ffff:a9fe:a9fe", "metadata"],
      ["fd00:ec2::254", "metadata"],
      ["169.254.1.1", "link-local"],
      ["fe80::1", "link-local"],
      ["FE80::abcd", "link-local"],
      ["fd12:3456::1", "private"],
      ["fc00::1", "private"],
      ["fec0::1", "private"],
      ["10.0.0.1", "private"],
      ["172.16.5.4", "private"],
      ["192.168.1.1", "private"],
      ["100.64.0.1", "private"],
      ["0.0.0.0", "reserved"],
      ["::", "reserved"],
      ["::127.0.0.1", "reserved"], // IPv4-compatible
      ["64:ff9b::7f00:1", "reserved"], // NAT64 well-known prefix wrapping 127.0.0.1
      ["64:ff9b::a9fe:a9fe", "reserved"], // NAT64 wrapping metadata
      ["2002:7f00:1::", "reserved"], // 6to4 embedding 127.0.0.1
      ["2001:0:7f00::1", "reserved"], // Teredo
      ["::ffff:0:7f00:1", "reserved"], // SIIT
      ["224.0.0.1", "multicast"],
      ["ff02::1", "multicast"],
      ["fe80::1%eth0", "invalid"], // zone ids are refused, not stripped
    ];
    for (const [ip, cls] of cases) {
      expect(classifyAddress(ip), ip).toBe(cls);
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("AT-EGR-02 non-canonical IPv4 literals (octal, hex, dword, short) are never public: inet_aton would read them as 127.0.0.1 (catches: a dialer that classifies a string the resolver then reinterprets)", () => {
    for (const s of ["0177.0.0.1", "2130706433", "0x7f.0.0.1", "0x7f000001", "127.1", "127.000.000.001", "017700000001", "127.0.0.1.", " 127.0.0.1"]) {
      expect(classifyAddress(s), s).toBe("invalid");
      expect(isPublicAddress(s), s).toBe(false);
    }
  });
});

const ALL_ALLOWED: EgressPolicyState = {
  subnets: { apps: [{ base: (172 << 24 | 30 << 16) >>> 0, mask: 0xffff0000 }] },
  appByIp: new Map([["172.30.0.5", "alice--chess"]]),
  accessRules: () => [{ line: 1, action: "allow", target: "all" }],
};

describe("egress gateway (live app containers)", () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    // server.close waits for idle keep-alive sockets; don't let a lingering one hold the hook.
    for (const s of servers.splice(0)) await Promise.race([s.close(), new Promise((r) => setTimeout(r, 200))]);
  });

  async function proxyOn(addrs: string[]): Promise<{ port: number; dialed: string[] }> {
    const dialed: string[] = [];
    const upstream: Server = createServer((s) => s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as { port: number }).port;
    servers.push({ close: () => new Promise<void>((r) => upstream.close(() => r())) });
    const probe: Server = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const h = await startProxyServer(
      {
        allow: () => true,
        resolve: async () => addrs,
        dial: (a) => {
          dialed.push(a);
          return connect(upPort, "127.0.0.1");
        },
      },
      "http",
      "127.0.0.1",
      port,
    );
    servers.push(h);
    return { port, dialed };
  }

  function send(port: number, head: string): Promise<string> {
    return new Promise((resolve) => {
      const s: Socket = connect(port, "127.0.0.1", () => s.write(head));
      let buf = "";
      s.on("data", (d) => (buf += d.toString()));
      s.on("close", () => resolve(buf));
      s.on("error", () => resolve(buf));
      setTimeout(() => s.destroy(), 1500);
    });
  }

  it("AT-EGR-03 an allowed NAME whose every answer is loopback, ULA, link-local or metadata is never dialed; a mixed answer dials only the public address (catches: DNS answer trusted at dial time)", async () => {
    const internal = await proxyOn(["127.0.0.1", "::1", "10.0.0.7", "169.254.169.254", "fd00:ec2::254", "::ffff:127.0.0.1"]);
    await send(internal.port, "GET / HTTP/1.1\r\nHost: allowed.example\r\n\r\n");
    expect(internal.dialed).toEqual([]);
    const mixed = await proxyOn(["127.0.0.1", "93.184.216.34"]);
    const reply = await send(mixed.port, "GET / HTTP/1.1\r\nHost: allowed.example\r\n\r\n");
    expect(mixed.dialed).toEqual(["93.184.216.34"]);
    expect(reply).toContain("200 OK");
  });

  it("AT-EGR-04 IP literals, bracketed IPv6 and junk in SNI/Host are refused by the policy even with `allow all` (catches: an app naming 127.0.0.1 or [::1] directly)", () => {
    for (const host of ["127.0.0.1", "[::1]", "::1", "169.254.169.254", "a b.example", "evil.example/x", "", "x".repeat(300)]) {
      const d = decide(ALL_ALLOWED, "172.30.0.5", host);
      expect(d.allow, host).toBe(false);
    }
    expect(normalizeHost("API.Example.com.")).toBe("api.example.com");
    // An unknown source on the bridge (a container the box did not start) gets nothing.
    expect(decide(ALL_ALLOWED, "172.30.9.9", "example.com").allow).toBe(false);
    expect(decide(ALL_ALLOWED, "10.9.9.9", "example.com").allow).toBe(false);
  });

  it("AT-EGR-05 wildcards cover subdomains on label boundaries only, in the gateway and in the signed access list (catches: `*.example.com` admitting evil-example.com or example.com.evil.test)", () => {
    for (const host of ["evil-example.com", "example.com", "aexample.com", "example.com.evil.test", "xexample.com"]) {
      expect(hostMatches("*.example.com", host), host).toBe(false);
      expect(decideAppAccess("allow *.example.com\n", host).result, host).toBe("deny");
    }
    expect(hostMatches("*.example.com", "api.example.com")).toBe(true);
    expect(decideAppAccess("allow *.example.com\n", "API.EXAMPLE.COM.").result).toBe("allow");
    // A list cannot even hold an IP literal, a port, a URL or localhost.
    for (const t of ["127.0.0.1", "[::1]", "::1", "example.com:8443", "https://example.com", "localhost", "a.localhost", "*", "*.*.com"]) {
      expect("error" in checkAccessTarget(t), t).toBe(true);
    }
  });

  it("AT-EGR-06 the HTTP proxy refuses duplicate Host, a Host on another port, and a request with no Host (catches: steering the splice to a second host or port)", () => {
    expect(parseHttpHost("GET / HTTP/1.1\r\nHost: a.example\r\nHost: b.example")).toBeNull();
    expect(parseHttpHost("GET / HTTP/1.1\r\nHost: a.example:8080")).toBeNull();
    expect(parseHttpHost("GET / HTTP/1.1\r\nX: y")).toBeNull();
    expect(parseHttpHost("GET http://internal.example/ HTTP/1.1\r\nHost: a.example")).toBe("a.example");
    expect(parseHttpHost("GARBAGE\r\nHost: a.example")).toBeNull();
  });
});

const DNS: Record<string, string[]> = {
  "shop.example.com": ["93.184.216.34"],
  "rebind.example.com": ["93.184.216.35", "127.0.0.1"],
  "home.alice.flagship.services": ["149.248.216.86"],
  "home.alice.flagship.services.": ["149.248.216.86"],
  "nas.example.com": ["192.168.1.30"],
};

function judgeWorld(grant: Partial<BrowserGrantRequest>, protectedHosts?: { names: string[]; addresses: string[] }) {
  const grants = new BrowserGrants(() => 1_000);
  grants.approve({ serviceId: "app-a", capabilities: ["navigate"], origins: ["shop.example.com", "*.example.com"], duration: "service", ...grant });
  return new BrowserJudge({
    grants,
    resolve: async (h) => DNS[h] ?? [],
    ...(protectedHosts ? { protectedHosts: () => protectedHosts } : {}),
  });
}

describe("app browser (SEC-BROWSER-002)", () => {
  it("AT-EGR-07 numeric URL spellings, a rebinding answer with one internal address, and private space without a LAN grant are refused (catches: judging the URL string, or the first DNS answer only)", async () => {
    const j = judgeWorld({});
    for (const url of ["http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/latest/meta-data", "http://169.254.169.254/", "http://[fd00:ec2::254]/"]) {
      const d = await j.judge({ serviceId: "app-a", url, kind: "subresource", initiatorUrl: "https://shop.example.com/" });
      expect(d.allow, url).toBe(false);
    }
    expect(await j.judge({ serviceId: "app-a", url: "https://rebind.example.com/", kind: "document" })).toMatchObject({ allow: false, code: "protected-destination" });
    expect(await j.judge({ serviceId: "app-a", url: "https://nas.example.com/", kind: "document" })).toMatchObject({ allow: false, code: "local-network" });
    expect(await j.judge({ serviceId: "app-a", url: "file:///etc/passwd", kind: "document" })).toMatchObject({ allow: false, code: "scheme" });
    // Another app's grant never covers this app.
    expect(await j.judge({ serviceId: "app-b", url: "https://shop.example.com/", kind: "document" })).toMatchObject({ allow: false, code: "no-grant" });
  });

  // Was FINDING AT-EGR-08 (fixed: the judge compares canonical hosts): BrowserJudge.destination (packages/server-daemon/src/browser/policy/judge.ts,
  // `protectedHosts.names.some((n) => n.toLowerCase() === host)`) compares the URL host verbatim, so the
  // server's own name with a trailing dot ("home.alice.flagship.services.") is not recognised as "this
  // server". A page in a granted site can then fetch https://<box>./ as an ordinary public destination.
  it("AT-EGR-08 the server's own name is refused in every spelling, trailing dot included (catches: a name check that does not normalise the FQDN)", async () => {
    const j = judgeWorld({}, { names: ["home.alice.flagship.services"], addresses: ["10.255.255.1"] });
    const plain = await j.judge({ serviceId: "app-a", url: "https://home.alice.flagship.services/", kind: "subresource", initiatorUrl: "https://shop.example.com/" });
    expect(plain).toMatchObject({ allow: false, code: "protected-destination" });
    const dotted = await j.judge({ serviceId: "app-a", url: "https://home.alice.flagship.services./api/screens", kind: "subresource", initiatorUrl: "https://shop.example.com/" });
    expect(dotted).toMatchObject({ allow: false, code: "protected-destination" });
  });

  // Was FINDING AT-EGR-09 (fixed: browser/protectedTargets.ts is wired in): the production call to bootstrapBrowserBundle (packages/server-daemon/src/index.ts,
  // the `bootstrapBrowserBundle({ cdpEndpoint, dataDir, ... egress: {...} })` block) passes neither
  // `protectedHosts` nor `egress.protectedAddresses`, so the judge's "this server" refusal and the pinning
  // proxy's own-address refusal are never armed on a real box. With a whole-LAN grant (which describeGrant
  // promises excludes "this server") the app browser can reach the box's own LAN address and the browser
  // network's gateway. The app browser is OFF (APP_BROWSER.enabled), which bounds the impact today.
  it("AT-EGR-09 the live box tells the browser judge and the pinning proxies its own names and addresses (catches: a guard whose input is never wired)", () => {
    const src = readFileSync(join(ROOT, "packages/server-daemon/src/index.ts"), "utf8");
    const call = src.slice(src.indexOf("await bootstrapBrowserBundle({"), src.indexOf("await bootstrapBrowserBundle({") + 1200);
    expect(call).toMatch(/protectedHosts\s*:/);
    expect(call).toMatch(/protectedAddresses\s*:/);
  });

  it("AT-EGR-07b a whole-LAN grant without protected addresses admits the browser network gateway (documents the effect of AT-EGR-09)", async () => {
    DNS["gw.example.com"] = ["172.31.0.1"];
    const j = judgeWorld({ localNetwork: { kind: "whole-lan" } });
    const d = await j.judge({ serviceId: "app-a", url: "http://gw.example.com/", kind: "document" });
    expect(d.allow).toBe(true);
    const armed = judgeWorld({ localNetwork: { kind: "whole-lan" } }, { names: [], addresses: ["172.31.0.1"] });
    expect(await armed.judge({ serviceId: "app-a", url: "http://gw.example.com/", kind: "document" })).toMatchObject({ allow: false, code: "protected-destination" });
  });
});

describe("per-app pinning proxies", () => {
  let origin: HttpServer | null = null;
  let proxies: ServiceProxies | null = null;
  afterEach(async () => {
    await proxies?.closeAll();
    proxies = null;
    await new Promise<void>((r) => (origin ? origin.close(() => r()) : r()));
    origin = null;
  });

  async function setup(): Promise<{ originPort: number; svc: ServiceProxies }> {
    origin = createHttpServer((_q, s) => s.end("origin"));
    await new Promise<void>((r) => origin!.listen(0, "127.0.0.1", r));
    const originPort = (origin.address() as { port: number }).port;
    proxies = new ServiceProxies({ dial: () => ({ host: "127.0.0.1", port: originPort }) });
    return { originPort, svc: proxies };
  }

  function connectVia(proxyUrl: string, target: string): Promise<string> {
    const u = new URL(proxyUrl);
    return new Promise((resolve) => {
      const s = connect(Number(u.port), u.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`));
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n")) {
          s.destroy();
          resolve(buf.split("\r\n")[0]!);
        }
      });
      s.on("close", () => resolve(buf.split("\r\n")[0] || "closed"));
      s.on("error", () => resolve("error"));
    });
  }

  it("AT-EGR-10 an approval on app A's proxy opens nothing on app B's, and loopback/metadata are refused even when 'approved' (catches: a shared proxy or a judge bypass reaching internal space)", async () => {
    const { svc } = await setup();
    const a = await svc.proxyFor("alice--a");
    const b = await svc.proxyFor("alice--b");
    svc.allow("alice--a", "shop.example.com", ["93.184.216.34"]);
    expect(await connectVia(a, "shop.example.com:443")).toMatch(/200/);
    expect(await connectVia(b, "shop.example.com:443")).toMatch(/403/);
    svc.allow("alice--a", "evil.example.com", ["127.0.0.1"]);
    expect(await connectVia(a, "evil.example.com:443")).toMatch(/403/);
    svc.allow("alice--a", "meta.example.com", ["169.254.169.254"]);
    expect(await connectVia(a, "meta.example.com:80")).toMatch(/403/);
    // Chromium's default (deny-all) proxy never connects anything.
    const deny = await svc.denyAll();
    expect(await connectVia(deny, "shop.example.com:443")).toMatch(/403/);
  });

  // Was FINDING AT-EGR-11 (fixed: approvals are keyed by scheme, host and port): PinningProxy.allow(host, addresses) (packages/server-daemon/src/browser/pinningProxy.ts)
  // keys an approval by host only. The judge approved shop.example.com for an https page on 443, yet the
  // app's proxy will CONNECT shop.example.com on any port (22, 25, 6379...) for the approval's TTL. Low:
  // only traffic that escapes CDP interception would use it, but the proxy is meant to be the backstop.
  it("AT-EGR-11 an approved host is reachable only on the port the judge approved (catches: host-only pinning)", async () => {
    const { svc } = await setup();
    const a = await svc.proxyFor("alice--a");
    svc.allow("alice--a", "shop.example.com", ["93.184.216.34"]);
    expect(await connectVia(a, "shop.example.com:443")).toMatch(/200/);
    expect(await connectVia(a, "shop.example.com:22")).toMatch(/403/);
  });
});

describe("AI provider fetch (N12)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const resolve = async (h: string) => (h === "localtest.me" ? ["127.0.0.1"] : h === "evil.example" ? ["93.184.216.40"] : ["93.184.216.34"]);

  it("AT-EGR-12 a cross-origin redirect drops the key and the prompt, a 307/308 cross-origin is refused, and no hop reaches metadata or loopback (catches: credentials or prompts following a redirect)", async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: unknown }> = [];
    let script: Array<() => Response> = [];
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return script.shift()!();
    });
    const f = guardedFetch({ resolve });
    const auth = { authorization: "Bearer sk-secret", "x-api-key": "k", "content-type": "application/json" };

    script = [() => new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } }), () => new Response("{}", { status: 200 })];
    await f("https://api.provider.example/v1/chat", { method: "POST", headers: auth, body: '{"prompt":"secret"}' });
    expect(calls[1]!.url).toBe("https://evil.example/collect");
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.body).toBeUndefined();
    expect(Object.keys(calls[1]!.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(calls[1]!.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("x-api-key");

    script = [() => new Response(null, { status: 307, headers: { location: "https://evil.example/collect" } })];
    await expect(f("https://api.provider.example/v1/chat", { method: "POST", headers: auth, body: "{}" })).rejects.toThrow(/another host/);

    for (const loc of ["http://169.254.169.254/latest/meta-data/", "https://[::ffff:a9fe:a9fe]/", "https://127.0.0.1/", "https://localtest.me/", "https://[::1]/", "https://10.0.0.1/"]) {
      script = [() => new Response(null, { status: 302, headers: { location: loc } })];
      const n = calls.length;
      await expect(f("https://api.provider.example/v1/chat", { method: "POST", headers: auth, body: "{}" }), loc).rejects.toBeInstanceOf(UnsafeBaseUrlError);
      expect(calls.length - n, loc).toBe(1); // the internal hop was never fetched
    }
  });

  it("AT-EGR-13 git clone of an untrusted URL: no redirects, no hooks or helpers, only http(s), the checked address pinned, nothing of the daemon's environment (catches: a clone that follows a redirect to an unchecked host or runs repo hooks)", () => {
    const c = hardenedGitConfig("https://github.com/a/b.git", "github.com", ["140.82.112.3", "2606:50c0:8000::153"]);
    const settings = c.filter((_, i) => i % 2 === 1);
    for (const s of ["http.followRedirects=false", "protocol.allow=never", "protocol.https.allow=always", "core.hooksPath=/dev/null", "credential.helper=", "http.proxy=", "http.sslVerify=true", "submodule.recurse=false"]) {
      expect(settings, s).toContain(s);
    }
    expect(settings).toContain("http.curloptResolve=github.com:443:140.82.112.3");
    expect(settings).toContain("http.curloptResolve=github.com:443:[2606:50c0:8000::153]");
    expect(settings.some((s) => /protocol\.(file|ext|ssh|git)\.allow=always/.test(s))).toBe(false);
    expect(Object.keys(GIT_CLONE_ENV).sort()).toEqual(["GIT_ALLOW_PROTOCOL", "GIT_ASKPASS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH"]);
    expect(GIT_CLONE_ENV.GIT_ALLOW_PROTOCOL).toBe("https:http");
    expect(GIT_CLONE_ENV.HOME).toBe("/nonexistent");
  });
});

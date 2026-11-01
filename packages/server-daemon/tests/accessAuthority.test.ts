import { describe, expect, it } from "vitest";
import { accessAuthorityMode, buildAccessAuthority, sameVerdict, type AccessVerdict } from "../src/accessAuthority.js";
import type { BoxSigner } from "../src/keyCustodian.js";
import { prepareAppRequest, stripForwardingHeaders, type SessionInfo } from "../src/serviceProxy.js";
import type { InstalledService } from "../src/servicePlatform.js";

const HOST = "club.home.alice.flagship.services";
const app = {
  serviceId: "alice--club",
  urlLabel: "club",
  manifest: { name: "Club", access: { enabled: true, default_role: "member", public_routes: ["/hook"] } },
  membership: { stableIdFor: () => "stable" },
} as unknown as InstalledService;
const signer = { boxPublicKey: () => new Uint8Array(32), signAsBox: () => new Uint8Array(64) } as unknown as BoxSigner;
const member: SessionInfo = { memberPub: new Uint8Array(32).fill(0xf1), stableId: "stable", role: "manager", external: true };
const req = (path = "/members", headers: Record<string, string> = {}) =>
  ({ method: "GET", path, headers: { host: HOST, cookie: "Flagship-App-Session=t", ...headers }, body: Buffer.alloc(0) }) as never;

function hook(mode: "shadow" | "rust", answer: AccessVerdict | Error, seen: unknown[] = []) {
  const disagreements: Array<[AccessVerdict, AccessVerdict | null]> = [];
  const a = buildAccessAuthority({
    mode,
    context: () => ({ principals: [], ownerAid: null, catchingUp: false }),
    call: async (_op, args) => {
      seen.push(args);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log: () => {},
  });
  const h = { ...a, onDisagree: (_ref: string, ts: AccessVerdict, r: AccessVerdict | null) => (a.onDisagree?.(_ref, ts, r), disagreements.push([ts, r])) };
  return { h, disagreements, stats: a.stats };
}

async function run(mode: "shadow" | "rust", answer: AccessVerdict | Error, session: SessionInfo | null, path = "/members", seen: unknown[] = []) {
  const { h, disagreements, stats } = hook(mode, answer, seen);
  const p = await prepareAppRequest(
    app,
    req(path),
    { injector: signer, resolveSession: () => session, accessMode: () => "members-only", authority: h },
    { routedHost: HOST },
  );
  await new Promise((r) => setTimeout(r, 0));
  return { p, disagreements, stats: stats() };
}

describe("accessAuthorityMode", () => {
  it("is shadow when the socket is up, TypeScript otherwise, and the flag overrides both", () => {
    expect(accessAuthorityMode({}, "/s", () => true)).toBe("shadow");
    expect(accessAuthorityMode({}, "/s", () => false)).toBe("ts");
    expect(accessAuthorityMode({ FLAGSHIP_ACCESS_AUTHORITY: "rust" }, "/s", () => false)).toBe("rust");
    expect(accessAuthorityMode({ FLAGSHIP_ACCESS_AUTHORITY: "TS" }, "/s", () => true)).toBe("ts");
    expect(accessAuthorityMode({ FLAGSHIP_ACCESS_AUTHORITY: "maybe" }, "/s", () => false)).toBe("ts");
  });
  it("compares outcome, visitor, rank, identity and external", () => {
    const m = { outcome: "forward", visitor: "member", role: "manager", identity: "aa", external: true };
    expect(sameVerdict(m, { ...m })).toBe(true);
    expect(sameVerdict(m, { ...m, role: "master" })).toBe(false);
    expect(sameVerdict(m, { ...m, external: false })).toBe(false);
    expect(sameVerdict({ outcome: "deny" }, { outcome: "deny", visitor: "x" })).toBe(true);
  });
});

describe("the Rust decision beside the proxy", () => {
  it("tells Rust only facts: the routed app, the request, the cookie token; never a decision", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await run("shadow", { outcome: "deny" }, member, "/members", seen);
    expect(seen[0]).toMatchObject({ serviceRef: "alice--club", routedHost: HOST, sessionToken: "t", apiKey: "none", publicRoutes: ["/hook"] });
    expect(Object.keys(seen[0]!)).not.toContain("allowed");
    expect(Object.keys(seen[0]!)).not.toContain("role");
  });
  it("shadow keeps TypeScript's answer and records the disagreement", async () => {
    const r = await run("shadow", { outcome: "deny" }, member);
    expect(r.p.kind).toBe("forward");
    expect(r.disagreements).toHaveLength(1);
    expect(r.stats.disagreed).toBe(1);
  });
  it("shadow with Rust unreachable keeps TypeScript's answer", async () => {
    const r = await run("shadow", new Error("down"), member);
    expect(r.p.kind).toBe("forward");
    expect(r.stats.unavailable).toBe(1);
  });
  it("shadow agreeing records nothing", async () => {
    const r = await run("shadow", { outcome: "forward", visitor: "member", role: "manager", identity: "f1".repeat(32), external: true }, member);
    expect(r.disagreements).toHaveLength(0);
  });
  it("rust: a deny wins over TypeScript's forward", async () => {
    const r = await run("rust", { outcome: "deny" }, member);
    expect(r.p.kind).toBe("respond");
  });
  it("rust: an unreachable decision refuses (fail closed)", async () => {
    const r = await run("rust", new Error("down"), member);
    expect(r.p.kind).toBe("respond");
  });
  it("rust: a lower rank wins and is what the app sees", async () => {
    const r = await run("rust", { outcome: "forward", visitor: "member", role: "member", identity: "f1".repeat(32), external: true }, member);
    expect(r.p.kind === "forward" && r.p.headers["x-flagship-role"]).toBe("member");
  });
  it("rust: anonymous on a public route drops the member", async () => {
    const r = await run("rust", { outcome: "forward", visitor: "anonymous", role: null, identity: null }, member, "/hook");
    expect(r.p.kind === "forward" && r.p.headers["x-flagship-visitor"]).toBe("anonymous");
  });
  it("rust: a member the proxy did not resolve is refused, never conjured", async () => {
    const r1 = await run("rust", { outcome: "forward", visitor: "member", role: "master", identity: "e1".repeat(32), external: false }, member);
    expect(r1.p.kind).toBe("respond");
    const r2 = await run("rust", { outcome: "forward", visitor: "member", role: "master", identity: "e1".repeat(32), external: false }, null);
    expect(r2.p.kind).toBe("respond");
    const r3 = await run("rust", { outcome: "forward", visitor: "api", role: "api", identity: "apikey:k" }, null);
    expect(r3.p.kind).toBe("respond");
  });
});

describe("what the app is told about the request (H5)", () => {
  it("drops client-written proxy-chain headers and states the routed host itself", async () => {
    const p = await prepareAppRequest(
      app,
      {
        method: "GET",
        path: "/hook",
        headers: { host: "blog.home.alice.flagship.services", "x-forwarded-host": "blog.home.alice.flagship.services", "x-forwarded-for": "10.0.0.1", forwarded: "for=1;host=blog", x_forwarded_proto: "http", "x-real-ip": "1.2.3.4", "x-original-url": "/admin" },
        body: Buffer.alloc(0),
      } as never,
      { injector: signer, accessMode: () => "members-only" },
      { routedHost: HOST },
    );
    expect(p.kind).toBe("forward");
    if (p.kind !== "forward") return;
    expect(p.headers.host).toBe(HOST);
    expect(p.headers["x-forwarded-host"]).toBe(HOST);
    expect(p.headers["x-forwarded-proto"]).toBe("https");
    for (const k of ["x-forwarded-for", "forwarded", "x_forwarded_proto", "x-real-ip", "x-original-url"]) expect(p.headers[k]).toBeUndefined();
  });
  it("stripForwardingHeaders keeps everything else", () => {
    expect(stripForwardingHeaders({ accept: "a", "X-Forwarded-For": "x", cookie: "c" })).toEqual({ accept: "a", cookie: "c" });
  });
  it("a forged Host cannot make a sibling's origin the app's own", async () => {
    const p = await prepareAppRequest(
      app,
      { method: "POST", path: "/members", headers: { host: "evil.home.alice.flagship.services", origin: "https://evil.home.alice.flagship.services", cookie: "Flagship-App-Session=t" }, body: Buffer.alloc(0) } as never,
      { injector: signer, resolveSession: () => member, accessMode: () => "members-only" },
      { routedHost: HOST },
    );
    expect(p.kind).toBe("respond");
  });
});

describe("the flagship-access unit", () => {
  it("serves the socket the daemon looks for, reads files and nothing more, and admits the daemon's uid", async () => {
    const { ACCESS_SOCKET } = await import("../src/accessAuthority.js");
    const { ACCESS_SOCKET_PATH, accessServiceUnit, rustSelectScript, rustExecScript } = await import("../src/rustStack/units.js");
    expect(ACCESS_SOCKET_PATH).toBe(ACCESS_SOCKET);
    const u = accessServiceUnit();
    for (const line of ["PrivateNetwork=yes", "CapabilityBoundingSet=CAP_DAC_READ_SEARCH", "ProtectSystem=strict", "NoNewPrivileges=yes", "RestrictAddressFamilies=AF_UNIX", `confirm access ${ACCESS_SOCKET}`]) {
      expect(u).toContain(line);
    }
    expect(rustSelectScript()).toContain("FLAGSHIP_ACCESS_ALLOW_UIDS=0");
    expect(rustExecScript()).toContain("keyd|broker|core|access");
  });
});

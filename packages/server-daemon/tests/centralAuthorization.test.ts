import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_FAMILIES, authorizeRoute, centralAuthorization, principalOf } from "../src/centralAuthorization.js";
import type { HttpRequest } from "../src/runtime.js";

const req = (method: string, path: string, headers: Record<string, string> = {}): HttpRequest =>
  ({ method, path, headers, body: "" }) as unknown as HttpRequest;

describe("principalOf", () => {
  it("is anonymous without a token, share for fss_, companion by the store's flag, owner otherwise", () => {
    const companion = (r: HttpRequest) => r.headers["x-flagship-session"] === "comp";
    expect(principalOf(req("GET", "/api/x"), companion)).toBe("anonymous");
    expect(principalOf(req("GET", "/api/x", { "x-flagship-session": "fss_abc" }), companion)).toBe("share");
    expect(principalOf(req("GET", "/api/x", { "x-flagship-session": "comp" }), companion)).toBe("companion");
    expect(principalOf(req("GET", "/api/x", { "x-flagship-session": "owner" }), companion)).toBe("owner");
    expect(principalOf(req("GET", "/api/x?sessionToken=comp"), () => true)).toBe("companion");
  });
});

describe("companion (Remote) matrix", () => {
  const ok = (m: string, p: string) => authorizeRoute("companion", m, p).allow;

  it("reads the screens and asks for writes through the relay", () => {
    expect(ok("GET", "/api/screens/server-detail")).toBe(true);
    expect(ok("GET", "/api/screens/services/chess/members?x=1")).toBe(true);
    expect(ok("POST", "/api/companion/request-write")).toBe(true);
    expect(ok("GET", "/api/companion/my-pending")).toBe(true);
    expect(ok("GET", "/api/deadman")).toBe(true);
  });

  it("cannot build, deploy, mint credentials, move backups, rotate identity or reach AI sessions", () => {
    const denied: Array<[string, string]> = [
      ["POST", "/api/build/mcp"], ["GET", "/api/build/sessions"], ["PUT", "/api/build/x/files"], ["POST", "/api/build/x/deploy"],
      ["POST", "/api/llm/sessions"], ["GET", "/api/llm/sessions/x"], ["GET", "/api/screens/llm/sessions/x"],
      ["POST", "/api/screens/llm/sessions/x/reply"], ["GET", "/api/screens/vibe-code/x"], ["POST", "/api/screens/vibe-code/start"],
      ["GET", "/api/backups/app1"], ["POST", "/api/backups/app1"], ["GET", "/api/screens/server-archive"], ["GET", "/api/screens/app-backup/x"],
      ["POST", "/api/identity/rotate"], ["POST", "/api/screens/services/copy"], ["POST", "/api/screens/orders/send"],
      ["DELETE", "/api/screens/paired-sessions/x"], ["GET", "/api/screens/paired-sessions"], ["POST", "/api/screens/companion/mint-ticket"],
      ["POST", "/api/service-access/invite"], ["POST", "/api/shares/accept"], ["POST", "/api/deadman/affirm"],
      ["GET", "/mcp/build/x"], ["POST", "/mcp/build/x"], ["GET", "/api/something-new"], ["POST", "/api/screens/anything"],
      ["PATCH", "/api/screens/server-detail"], ["DELETE", "/api/screens/server-detail"],
    ];
    for (const [m, p] of denied) expect(ok(m, p), `${m} ${p}`).toBe(false);
  });

  it("cannot reach a denied route through path tricks", () => {
    for (const p of ["/api/screens/../build/mcp", "/api/screens/%2e%2e/build", "/api/screens/%2E%2E/build/mcp", "/api//build/mcp", "/api/screens/./llm", "/api/screens\\..\\build", "/api/SCREENS/llm/sessions"]) {
      expect(ok("GET", p), p).toBe(false);
    }
    expect(ok("GET", "/api/screens-evil/x")).toBe(false);
    expect(ok("GET", "/api/screensX")).toBe(false);
  });
});

describe("share (co-manager) matrix", () => {
  it("reaches only /api/shares", () => {
    expect(authorizeRoute("share", "POST", "/api/shares/update").allow).toBe(true);
    expect(authorizeRoute("share", "GET", "/api/shares/me").allow).toBe(true);
    for (const p of ["/api/screens/server-detail", "/api/build/mcp", "/api/llm/sessions", "/api/backups/x", "/api/identity/rotate", "/api/sharesX/me", "/api/shares/../build"]) {
      expect(authorizeRoute("share", "GET", p).allow, p).toBe(false);
    }
  });
});

describe("owner and anonymous are not restricted here", () => {
  it("passes through to each handler's own gate", () => {
    expect(authorizeRoute("owner", "POST", "/api/build/mcp").allow).toBe(true);
    expect(authorizeRoute("anonymous", "POST", "/api/companion/redeem").allow).toBe(true);
  });
});

describe("centralAuthorization handler", () => {
  it("answers 403 with a code for a restricted principal and falls through otherwise", async () => {
    const isCompanion = (r: HttpRequest) => r.headers["x-flagship-session"] === "comp";
    const gate = centralAuthorization({ isCompanionRequest: isCompanion });
    const denied = await gate(req("POST", "/api/build/mcp", { "x-flagship-session": "comp" }));
    expect(denied?.status).toBe(403);
    expect(JSON.parse(String(denied!.body)).code).toBe("route-not-allowed-for-session");
    expect(await gate(req("GET", "/api/screens/server-detail", { "x-flagship-session": "comp" }))).toBeNull();
    expect(await gate(req("POST", "/api/build/mcp", { "x-flagship-session": "owner" }))).toBeNull();
    expect(await gate(req("GET", "/health", { "x-flagship-session": "comp" }))).toBeNull();
    expect(await gate(req("GET", "/api/anything", { "x-flagship-session": "fss_1" }))).not.toBeNull();
  });
});

describe("route family inventory", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("classifies every control-API family the daemon serves", () => {
    const src = join(import.meta.dirname, "../src");
    const found = new Set<string>();
    for (const file of walk(src)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/["'`](\/(?:api|mcp)\/[a-z_-]+)/g)) found.add(m[1]!);
    }
    // /api/... prefixes that belong to other hosts or are only mentioned in text.
    // Calls this box makes to Flagship, text in prompts/comments, and paths served by the apps themselves.
    const ignore = new Set(["/api/adapters", "/api/boot", "/api/inference", "/api/items", "/api/public", "/api/publicity", "/api/v", "/api/health", "/api/server", "/api/order", "/api/users", "/api/username", "/api/screens-events", "/api/free-ai", "/api/leads", "/api/releases", "/api/notices", "/api/accounts", "/api/dev", "/api/stats", "/api/services-zone", "/api/dns-01", "/api/admin", "/api/directory", "/api/data", "/api/config", "/api/lists", "/api/devices", "/api/auth", "/api/orders", "/api/sample", "/api/register", "/api/route", "/api/routing", "/api/dns"]);
    const missing = [...found].filter((p) => !(p in ROUTE_FAMILIES) && !ignore.has(p)).sort();
    expect(missing, `classify these route families in ROUTE_FAMILIES: ${missing.join(", ")}`).toEqual([]);
  });
});

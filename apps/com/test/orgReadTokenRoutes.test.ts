/**
 * Org read tokens through the Worker's routes on a real D1 schema: minted by a seat key, required
 * (admin or servers-add) by the org routes no shipped client reads yet, and accepted but not
 * required by the rest.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { bindingSubject, endpointFor, LIMITS } from "../src/rateLimit.js";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { signOrgReadTokenRequest, type OrgReadTokenRequest } from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "../../../packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const resolveRefs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(resolveRefs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x)]));
};
const chain = resolveRefs(V.chains[0]);
const grants = resolveRefs(V.seatBooks[0]).grants;
const ORG = V.orgId as string;
const T0 = chain.entries[1].record.issuedAt + 4 * 3_600_000;

afterEach(() => {
  vi.useRealTimers();
});

const call = async (env: ControlPlaneEnv, method: string, path: string, body?: unknown, token?: string | null) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = (await tryControlPlane(new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env))!;
  return { status: r.status, body: (await r.json()) as any };
};

let n = 0;
async function mint(env: ControlPlaneEnv, name: string): Promise<string> {
  const k = V.keys[name];
  const request: OrgReadTokenRequest = { orgId: ORG, subject: `seat:${k.seatId}`, pubHex: k.binding.ed25519PubHex, issuedAt: T0, nonceHex: (++n).toString(16).padStart(32, "0") };
  const signature = signOrgReadTokenRequest(request, (m) => ed25519.sign(m, Buffer.from(k.edSeedHex, "hex")));
  const r = await call(env, "POST", `/api/orgs/${ORG}/read-token`, { request, signature });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

describe("org read token routes", () => {
  it("mint, the gated audit reads, and the ungated reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const sqlite = createSqliteD1();
    try {
      const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "k".repeat(64) };
      expect((await call(env, "POST", "/api/orgs", { name: "acme", entry: chain.entries[0] })).status).toBe(200);
      expect((await call(env, "POST", `/api/orgs/${ORG}/authority`, { entry: chain.entries[1] })).status).toBe(200);
      for (const g of grants) {
        sqlite.raw.prepare("INSERT INTO org_objects (org_id, kind, object_key, body_json, issued_at, stored_at) VALUES (?, 'grant', ?, ?, ?, 0)")
          .run(ORG, `${g.grant.seatId}:${g.grant.issuedAt}`, JSON.stringify(g), g.grant.issuedAt);
      }

      const admin = await mint(env, "A founder");
      const member = await mint(env, "M member");
      const scoped = await mint(env, "S scoped admin");

      for (const sub of ["export", "log"]) {
        const none = await call(env, "GET", `/api/orgs/${ORG}/${sub}`);
        expect(none.status, sub).toBe(401);
        expect(none.body.code).toBe("org-read-token-required");
        expect((await call(env, "GET", `/api/orgs/${ORG}/${sub}`, undefined, member)).status, sub).toBe(401);
        expect((await call(env, "GET", `/api/orgs/${ORG}/${sub}`, undefined, scoped)).status, sub).toBe(401);
        expect((await call(env, "GET", `/api/orgs/${ORG}/${sub}`, undefined, "ort1.bogus.bogus")).status, sub).toBe(401);
        expect((await call(env, "GET", `/api/orgs/${ORG}/${sub}`, undefined, admin)).status, sub).toBe(200);
      }
      const log = await call(env, "GET", `/api/orgs/${ORG}/log`, undefined, admin);
      expect(log.body.entries.length).toBeGreaterThan(0);

      for (const sub of ["authority", "seats", "ceremonies", "servers", "keys", "directory", "directory/slices", "connectors", "proposals", "plan"]) {
        expect((await call(env, "GET", `/api/orgs/${ORG}/${sub}`)).status, sub).toBe(200);
        expect((await call(env, "GET", `/api/orgs/${ORG}/${sub}`, undefined, member)).status, sub).toBe(200);
      }
    } finally {
      sqlite.close();
    }
  });

  it("has its own rate budget, per source and per org", () => {
    expect(endpointFor("POST", `/api/orgs/${ORG}/read-token`)).toBe("org-read-token");
    expect(endpointFor("GET", `/api/orgs/${ORG}/export`)).toBe("org-read");
    expect(bindingSubject("org-read-token", `/api/orgs/${ORG}/read-token`)).toBe(`orgs:${ORG}`);
    expect(LIMITS["org-read-token"].map((b) => b.axis).sort()).toEqual(["ip", "ip", "subject"]);
  });
});

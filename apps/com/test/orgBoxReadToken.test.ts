/**
 * The box's org read token client (server-daemon orgReadToken.ts) against the real `.com` routes
 * on a real D1 schema: an org server mints as `box:<domain>` with its STK, its token passes the
 * gate a box read will be held to (`requireOrgRead`, scope "any"), and stops passing once the
 * server is revoked. /log and /export stay admin-only, so a box's token is refused there.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { requireOrgRead } from "@flagship/control-plane";
import { D1Storage, type D1Database } from "@flagship/storage";
import { D1NonceStore } from "@flagship/boot-core";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { OrgReadToken } from "../../../packages/server-daemon/src/orgReadToken.js";

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
const ORG = V.orgId as string;
const T0 = chain.entries[1].record.issuedAt + 4 * 3_600_000;
const DOMAIN = "home.acme.flagship.services";
const stk = new Uint8Array(32).fill(9);
const stkPubHex = Buffer.from(ed25519.getPublicKey(stk)).toString("hex");

afterEach(() => vi.useRealTimers());

describe("box org read token through the .com routes", () => {
  it("an org server mints, reads with it, and the token is the one the gate accepts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const sqlite = createSqliteD1();
    try {
      const secret = "k".repeat(64);
      const db = sqlite as unknown as D1Database;
      const env: ControlPlaneEnv = { DB: db, ACCOUNT_READ_TOKEN_SECRET: secret };
      const viaWorker: typeof fetch = async (input, init) => (await tryControlPlane(new Request(input as string, init), env))!;
      expect((await viaWorker(`${ORIGIN}/api/orgs`, { method: "POST", body: JSON.stringify({ name: "acme", entry: chain.entries[0] }) })).status).toBe(200);
      expect((await viaWorker(`${ORIGIN}/api/orgs/${ORG}/authority`, { method: "POST", body: JSON.stringify({ entry: chain.entries[1] }) })).status).toBe(200);
      sqlite.raw.prepare("INSERT INTO org_objects (org_id, kind, object_key, body_json, issued_at, stored_at) VALUES (?, 'server', ?, ?, ?, 0)")
        .run(ORG, DOMAIN, JSON.stringify({ serverDomain: DOMAIN, identityPubKeyHex: stkPubHex }), T0 - 1000);
      sqlite.raw.prepare("INSERT INTO servers (server_domain, username, identity_pubkey_hex, registered_at) VALUES (?, ?, ?, ?)")
        .run(DOMAIN, `org-${ORG}`, stkPubHex, T0 - 1000);

      const sent: Array<string | null> = [];
      const recording: typeof fetch = async (input, init) => {
        if (!String(input).endsWith("/read-token")) sent.push(new Headers(init?.headers).get("authorization"));
        return viaWorker(input, init);
      };
      const box = new OrgReadToken({ comBaseUrl: ORIGIN, orgId: ORG, serverDomain: DOMAIN, boxPublicKey: () => ed25519.getPublicKey(stk), signAsBox: (m) => ed25519.sign(m, stk), fetchImpl: recording, log: () => undefined });
      const read = box.fetchFor();

      for (const sub of ["authority", "seats", "servers", "keys", "connectors", "proposals"]) {
        expect((await read(`${ORIGIN}/api/orgs/${ORG}/${sub}`)).status, sub).toBe(200);
      }
      expect(sent.every((a) => a !== null && a === sent[0])).toBe(true);
      const header = sent[0]!;
      expect(header).toMatch(/^Bearer ort1\./);

      const storage = new D1Storage(db);
      const deps = { orgs: storage.orgs, usernames: storage.usernames, servers: storage.servers, secret, nonces: new D1NonceStore(db), views: new Map() };
      const any = await requireOrgRead(deps, ORG, header, "any");
      expect(any.ok && any.claims.sub).toBe(`box:${DOMAIN}`);
      expect((await requireOrgRead(deps, ORG, header, "admin")).ok).toBe(false);
      // Admin-only routes refuse a box's token as they would any non-admin.
      expect((await read(`${ORIGIN}/api/orgs/${ORG}/log`)).status).toBe(401);

      await storage.servers.revoke(DOMAIN, "test", T0);
      expect((await requireOrgRead(deps, ORG, header, "any")).ok).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

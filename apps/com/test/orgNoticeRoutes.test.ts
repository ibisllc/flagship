/**
 * Delayed org changes through the Worker's routes on a real D1 schema (docs/enterprise-accounts.md "Delayed
 * changes"): a founder-removal notice is a ceremony keyed by its body hash, stamped with `.com`'s own clock; one
 * may be open at a time; the authority read serves the observed time; the removal applies only once its wait has
 * passed since `.com` saw it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  ORG_FOUNDER_NOTICE_MS,
  canonicalOrgDelayedChange,
  orgAuthorityHash,
  orgFounderRemovalOf,
  orgSha256Hex,
  signOrgApproval,
  signOrgReadTokenRequest,
  type OrgAuthorityRecord,
} from "@flagship/protocol";

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
const v1: OrgAuthorityRecord = chain.entries[1].record;
const T0 = v1.issuedAt + 3_600_000;
const DAY = 86_400_000;
const key = (name: string) => ({ ...V.keys[name], secret: Uint8Array.from(Buffer.from(V.keys[name].edSeedHex + V.keys[name].mldsaSeedHex, "hex")) });
const A = key("A founder");
const B = key("B admin");
const C = key("C admin");

afterEach(() => vi.useRealTimers());

const call = async (env: ControlPlaneEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const r = (await tryControlPlane(new Request(`${ORIGIN}${path}`, init), env))!;
  return { status: r.status, body: (await r.json()) as any };
};
let nonce = 0;
async function token(env: ControlPlaneEnv): Promise<string> {
  const request = { orgId: ORG, subject: `seat:${A.seatId}`, pubHex: A.binding.ed25519PubHex, issuedAt: Date.now(), nonceHex: (++nonce).toString(16).padStart(32, "0") };
  const signature = signOrgReadTokenRequest(request, (m) => ed25519.sign(m, Buffer.from(A.edSeedHex, "hex")));
  const r = await call(env, "POST", `/api/orgs/${ORG}/read-token`, { request, signature });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

function removal(target: typeof B, at: number) {
  const record = orgFounderRemovalOf(v1, target.seatId, at + ORG_FOUNDER_NOTICE_MS);
  const body = { orgId: ORG, oarVersion: 1, kind: "founder-removal" as const, nextRecordSha256: orgAuthorityHash(record), effectiveAt: record.issuedAt, issuedAt: at };
  const order = canonicalOrgDelayedChange(body);
  const approvals = [signOrgApproval({ orgId: ORG, oarVersion: 1, order, seatId: A.seatId, adminKeyId: A.keyId, issuedAt: at, notAfter: at + DAY }, A.secret)];
  return {
    sha: orgSha256Hex(order),
    open: { order: new TextDecoder().decode(order), payload: { record }, approvals },
    entry: { record, via: "founder-removal", approvals: [], notice: { body, approvals } },
  };
}

describe("org delayed-change notices on the Worker", () => {
  it("observes the notice, keeps one open at a time, and applies it only after its wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const env: ControlPlaneEnv = { DB: createSqliteD1() as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "k".repeat(64) };
    expect((await call(env, "POST", "/api/orgs", { name: "acme", entry: chain.entries[0] })).status).toBe(200);
    expect((await call(env, "POST", `/api/orgs/${ORG}/authority`, { entry: chain.entries[1] })).status).toBe(200);

    const n = removal(C, T0);
    const opened = await call(env, "POST", `/api/orgs/${ORG}/ceremonies`, n.open);
    expect(opened.status).toBe(200);
    expect(opened.body.openedAt).toBe(T0);
    const second = await call(env, "POST", `/api/orgs/${ORG}/ceremonies`, removal(B, T0).open);
    expect([second.status, second.body.code]).toEqual([409, "org-notice-open"]);

    const auth = { authorization: `Bearer ${await token(env)}` };
    expect((await call(env, "GET", `/api/orgs/${ORG}/authority`, undefined, auth)).body.noticeOpenedAt).toEqual({ [n.sha]: T0 });

    vi.setSystemTime(T0 + ORG_FOUNDER_NOTICE_MS - 60_000);
    const early = await call(env, "POST", `/api/orgs/${ORG}/authority`, { entry: n.entry });
    expect([early.status, early.body.code]).toEqual([403, "org-notice-early"]);
    vi.setSystemTime(T0 + ORG_FOUNDER_NOTICE_MS + 60_000);
    expect((await call(env, "POST", `/api/orgs/${ORG}/authority`, { entry: n.entry })).status).toBe(200);
    const after = (await call(env, "GET", `/api/orgs/${ORG}/authority`, undefined, { authorization: `Bearer ${await token(env)}` })).body;
    expect(after.currentVersion).toBe(2);
  });
});

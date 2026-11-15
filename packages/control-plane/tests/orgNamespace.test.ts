// Usernames and org names are one namespace (`<server>.<name>.<apex>`, docs/enterprise-accounts.md):
// an account cannot take an org's name, and an org cannot take an account's. Both answer `taken`,
// the sentence the apps already show for any held name.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveIRK, signClaimUsername } from "@flagship/protocol";
import { InMemoryOrgStorage, InMemoryStorage } from "@flagship/storage";
import { handleOrgCreate, handleUsernameClaim } from "../src/index.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};
const genesis = refs(V.chains[0]).entries[0];
const irk = deriveIRK({ seed: new Uint8Array(32).fill(11) });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const claim = (username: string, at: number) => ({
  request: { username, irkPub: hex(irk.publicKey), issuedAt: at },
  signature: hex(signClaimUsername({ username, irkPub: irk.publicKey, issuedAt: at }, irk)),
});

describe("usernames and org names share one namespace", () => {
  it("an account cannot claim a name an org holds", async () => {
    const s = new InMemoryStorage();
    const orgs = new InMemoryOrgStorage();
    const now = genesis.record.issuedAt + 3_600_000;
    expect((await handleOrgCreate({ orgs, usernames: s.usernames, now: () => now }, { name: "acme", entry: genesis })).status).toBe(200);
    const r = await handleUsernameClaim({ storage: s.usernames, orgs, now: () => now }, claim("acme", now));
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe("taken");
    expect((await handleUsernameClaim({ storage: s.usernames, orgs, now: () => now }, claim("acme-two", now))).status).toBe(200);
  });

  it("an org cannot take an account's name", async () => {
    const s = new InMemoryStorage();
    const orgs = new InMemoryOrgStorage();
    const now = genesis.record.issuedAt + 3_600_000;
    expect((await handleUsernameClaim({ storage: s.usernames, orgs, now: () => now }, claim("acme", now))).status).toBe(200);
    const r = await handleOrgCreate({ orgs, usernames: s.usernames, now: () => now }, { name: "acme", entry: genesis });
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe("taken");
  });
});

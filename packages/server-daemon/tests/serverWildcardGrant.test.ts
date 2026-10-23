import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signServerWildcardGrant } from "@flagship/protocol";
import { ServerWildcardGrantStore, buildServerWildcardGrantHttp, SERVER_WILDCARD_GRANT_PATH } from "../src/serverWildcardGrant.js";
import { boxCertSans, type HttpRequest } from "../src/runtime.js";
import { RemoteDnsChallengeWriter } from "../src/acme/remoteDnsChallengeWriter.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SERVER = "home.alice.flagship.services";
const stk = { privateKey: new Uint8Array(32).fill(5), publicKey: ed.getPublicKey(new Uint8Array(32).fill(5)) };
const admin = new Uint8Array(32).fill(6);
const irk = new Uint8Array(32).fill(7);

function store(opts: { adminPinned: boolean }) {
  return new ServerWildcardGrantStore({
    path: join(mkdtempSync(join(tmpdir(), "swg-")), "grant.json"),
    serverDomain: SERVER,
    stkPubHex: hex(stk.publicKey),
    authority: () => ({ ownerIrkPub: ed.getPublicKey(irk), ...(opts.adminPinned ? { adminRootPub: ed.getPublicKey(admin) } : {}), username: "alice" }),
  });
}
const grant = (key: Uint8Array, serverDomain = SERVER, issuedAt = 1_760_000_000_000) => ({
  issuedAt,
  signatureHex: hex(signServerWildcardGrant({ username: "alice", serverDomain, stkPubHex: hex(stk.publicKey), issuedAt }, (m) => ed.sign(m, key))),
});

describe("the admin's grant for the account's app names", () => {
  it("keeps only a grant the admin signed for this server, restarts once for the first, and survives a restart", async () => {
    const s = store({ adminPinned: true });
    let restarts = 0;
    const http = buildServerWildcardGrantHttp({ store: s, onFirstGrant: () => restarts++ });
    const post = (g: { issuedAt: number; signatureHex: string }) => http(SERVER_WILDCARD_GRANT_PATH, "POST", { body: Buffer.from(JSON.stringify({ issuedAt: g.issuedAt, signature: g.signatureHex })) } as HttpRequest);
    expect((await post(grant(irk)))?.status).toBe(403); // the IRK is not enough on an admin-pinned box
    expect((await post(grant(admin, "home2.alice.flagship.services")))?.status).toBe(403);
    expect((await post(grant(admin)))?.status).toBe(200);
    expect(restarts).toBe(1);
    expect((await post(grant(admin, SERVER, 1_760_000_000_001)))?.status).toBe(200); // a newer one replaces it, no restart
    expect(restarts).toBe(1);
    const again = new ServerWildcardGrantStore({ path: (s as unknown as { o: { path: string } }).o.path, serverDomain: SERVER, stkPubHex: hex(stk.publicKey), authority: () => ({ ownerIrkPub: ed.getPublicKey(irk), adminRootPub: ed.getPublicKey(admin), username: "alice" }) });
    expect((await again.load())?.issuedAt).toBe(1_760_000_000_001);
    // An admin root rotated since: the kept grant no longer verifies and is dropped.
    const rotated = new ServerWildcardGrantStore({ path: (s as unknown as { o: { path: string } }).o.path, serverDomain: SERVER, stkPubHex: hex(stk.publicKey), authority: () => ({ ownerIrkPub: ed.getPublicKey(irk), adminRootPub: ed.getPublicKey(new Uint8Array(32).fill(8)), username: "alice" }) });
    expect(await rotated.load()).toBeNull();
  });

  it("takes the IRK's grant on an account without an admin root", async () => {
    const s = store({ adminPinned: false });
    expect(await s.accept(grant(irk))).toBe(true);
  });

  it("adds *.<user> to the box's own certificate, and sends the grant only with that one challenge", async () => {
    expect(boxCertSans(SERVER, true)).toEqual([SERVER, `*.${SERVER}`]);
    expect(boxCertSans(SERVER, true, true)).toEqual([SERVER, `*.${SERVER}`, "*.alice.flagship.services"]);
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ recordId: "r1" }), { status: 200 });
    }) as never;
    const w = new RemoteDnsChallengeWriter({ serverId: SERVER, stk, fetchImpl, serverWildcardGrant: grant(admin) });
    await w.publishTxt(`_acme-challenge.${SERVER}`, "a");
    const cleanup = await w.publishTxt("_acme-challenge.alice.flagship.services", "b");
    await cleanup();
    expect(sent.map((b) => "serverWildcardGrant" in b)).toEqual([false, true, true]);
  });
});

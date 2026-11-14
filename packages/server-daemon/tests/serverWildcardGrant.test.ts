import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, SERVER_WILDCARD_GRANT_MAX_AGE_MS, SERVER_WILDCARD_GRANT_RENEW_AFTER_MS, signServerWildcardGrant } from "@flagship/protocol";
import { ServerWildcardGrantStore, buildServerWildcardGrantHttp, SERVER_WILDCARD_GRANT_PATH } from "../src/serverWildcardGrant.js";
import { boxCertSans, type HttpRequest } from "../src/runtime.js";
import { RemoteDnsChallengeWriter } from "../src/acme/remoteDnsChallengeWriter.js";
import { ServiceIssuer, localCsrSource } from "../src/acme/serviceIssuer.js";

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
const T0 = Date.now() - 60_000;
const grant = (key: Uint8Array, serverDomain = SERVER, issuedAt = T0) => ({
  issuedAt,
  signatureHex: hex(signServerWildcardGrant({ username: "alice", serverDomain, stkPubHex: hex(stk.publicKey), issuedAt }, (m) => ed.sign(m, key))),
});

describe("the admin's grant for the account's app names", () => {
  it("keeps only a grant the admin signed for this server, renews once for the first (no restart), and survives a restart", async () => {
    const s = store({ adminPinned: true });
    let renewals = 0;
    const http = buildServerWildcardGrantHttp({ store: s, onFirstGrant: () => renewals++ });
    const post = (g: { issuedAt: number; signatureHex: string }) => http(SERVER_WILDCARD_GRANT_PATH, "POST", { body: Buffer.from(JSON.stringify({ issuedAt: g.issuedAt, signature: g.signatureHex })) } as HttpRequest);
    expect((await post(grant(irk)))?.status).toBe(403); // the IRK is not enough on an admin-pinned box
    expect((await post(grant(admin, "home2.alice.flagship.services")))?.status).toBe(403);
    const first = await post(grant(admin));
    expect(first?.status).toBe(200);
    // The certificate is ordered in this run: a restart dropped a new box's order in flight (Failure 5).
    expect(JSON.parse(String(first?.body)).restarting).toBe(false);
    expect(renewals).toBe(1);
    expect((await post(grant(admin, SERVER, T0 + 1)))?.status).toBe(200); // a newer one replaces it, nothing to order
    expect(renewals).toBe(1);
    const again = new ServerWildcardGrantStore({ path: (s as unknown as { o: { path: string } }).o.path, serverDomain: SERVER, stkPubHex: hex(stk.publicKey), authority: () => ({ ownerIrkPub: ed.getPublicKey(irk), adminRootPub: ed.getPublicKey(admin), username: "alice" }) });
    expect((await again.load())?.issuedAt).toBe(T0 + 1);
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
    // *.alice covers the box's own name, and Let's Encrypt refuses an order that names both.
    expect(boxCertSans(SERVER, true, true)).toEqual([`*.${SERVER}`, "*.alice.flagship.services"]);
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

describe("the grant's age: renewal and expiry (issuance Lows)", () => {
  const DAY = 86_400_000;

  it("asks the admin devices for a new grant once the kept one is due, and takes only a newer, in-date one", async () => {
    const now = { t: 1_800_000_000_000 };
    const s = new ServerWildcardGrantStore({
      path: join(mkdtempSync(join(tmpdir(), "swg-")), "grant.json"),
      serverDomain: SERVER,
      stkPubHex: hex(stk.publicKey),
      authority: () => ({ ownerIrkPub: ed.getPublicKey(irk), adminRootPub: ed.getPublicKey(admin), username: "alice" }),
      now: () => now.t,
    });
    const http = buildServerWildcardGrantHttp({ store: s, onFirstGrant: () => {} });
    const granted = async () => JSON.parse(String((await http(SERVER_WILDCARD_GRANT_PATH, "GET", {} as HttpRequest))!.body)).granted as boolean;
    // An expired grant is refused outright.
    await expect(s.accept(grant(admin, SERVER, now.t - SERVER_WILDCARD_GRANT_MAX_AGE_MS - 1))).rejects.toThrow();
    expect(await s.accept(grant(admin, SERVER, now.t - 10 * DAY))).toBe(true);
    expect(await granted()).toBe(true);
    now.t += SERVER_WILDCARD_GRANT_RENEW_AFTER_MS;
    expect(await granted()).toBe(false); // the apps sign a fresh one when they see this
    // An older grant than the one held never replaces it.
    await expect(s.accept(grant(admin, SERVER, now.t - SERVER_WILDCARD_GRANT_RENEW_AFTER_MS - 20 * DAY))).rejects.toThrow();
    expect(await s.accept(grant(admin, SERVER, now.t - 1000))).toBe(false); // a renewal: no restart, used at once
    expect(s.current()?.issuedAt).toBe(now.t - 1000);
    expect(await granted()).toBe(true);
  });

  it("the issuer stops naming the account wildcard once the grant is past its age limit", () => {
    const now = { t: 1_800_000_000_000 };
    const g = grant(admin, SERVER, now.t - 1000);
    const issuer = new ServiceIssuer({
      controlPlaneBaseUrl: "https://flagshipserver.com",
      serverFqdn: SERVER,
      boxPubHex: hex(stk.publicKey),
      signAsBox: (m) => ed.sign(m, stk.privateKey),
      regGen: () => 1,
      wildcardGrant: () => g,
      csr: localCsrSource(),
      now: () => now.t,
    });
    expect(issuer.names("apps")).toEqual(["*.alice.flagship.services", `*.${SERVER}`]);
    now.t += SERVER_WILDCARD_GRANT_MAX_AGE_MS;
    expect(issuer.names("apps")).toEqual([`*.${SERVER}`]);
  });
});

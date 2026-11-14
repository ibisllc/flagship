/**
 * The browser extension's session (docs/browser-extension.md): an extension ticket redeems into a
 * session that opens no paired-session API, reads only the box's signed certificate fingerprint,
 * lasts 30 days, is listed to the owner as "extension" and is revoked like a Remote session.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";

import { ed, verifyDaemonStatusReport } from "@flagship/protocol";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import { EXTENSION_SESSION_TTL_MS } from "../../src/screens/companion.js";
import { InMemoryCompanionTicketStore } from "../../src/companion/companionTicketStore.js";
import { FilePairedSessionStore, defaultPairedSessionPath } from "../../src/pairedSessionStore.js";
import { buildSignedCertStatus } from "../../src/daemonStatusHeartbeat.js";
import type { HttpRequest } from "../../src/runtime.js";

const SERVER_FQDN = "home.alice.flagship.services";
const OWNER_TOKEN = "owner-tok-aaaaaaaaaaaa";

// A real EC certificate (the same fixture daemonStatusHeartbeat.test.ts uses).
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBujCCAV+gAwIBAgIUH7WZFo6yv08iclpgG7yjjRty/HQwCgYIKoZIzj0EAwIw
MjELMAkGA1UEBhMCVVMxFTATBgNVBAoMDExldHMgRW5jcnlwdDEMMAoGA1UEAwwD
UjExMB4XDTI2MDYxNDEwMTkxNFoXDTI2MDYxNjEwMTkxNFowMjELMAkGA1UEBhMC
VVMxFTATBgNVBAoMDExldHMgRW5jcnlwdDEMMAoGA1UEAwwDUjExMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAETZZP/X6443EC6PCK98VPWsWbqyNpCXbHgNyOBitN
aS4CIEcSszwZayEn48TZzwtWgVFO7+qMD0N3CRKviqpE56NTMFEwHQYDVR0OBBYE
FOgQ2l9j8rJtmqcG7MqXSh3J0gK0MB8GA1UdIwQYMBaAFOgQ2l9j8rJtmqcG7MqX
Sh3J0gK0MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAKUnlyT6
QX9GtjTqyre/j4m2NMk2wuppfEtNfn9HeS10AiEAhIx7FvMKCNtle3kw/vbRLaPs
DI8uD7t+By9uA9EEqQM=
-----END CERTIFICATE-----
`;
const CERT_SHA256 = new X509Certificate(CERT_PEM).fingerprint256.replace(/:/g, "").toLowerCase();

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
}

async function harness(nowRef: { t: number }) {
  const now = () => nowRef.t;
  const dir = mkdtempSync(join(tmpdir(), "ext-session-"));
  const pairedSessions = new FilePairedSessionStore(defaultPairedSessionPath(dir));
  await pairedSessions.add(OWNER_TOKEN, now());
  pairedSessions.now = now;
  const stk = ed.utils.randomPrivateKey();
  const stkPub = ed.getPublicKey(stk);
  const handle = buildScreensHttp({
    gate: pairedSessions,
    serverFqdn: SERVER_FQDN,
    username: "alice",
    daemonVersion: "0.0.1-test",
    startedAt: 1_000,
    now,
    pairedSessions,
    companion: {
      ticketStore: new InMemoryCompanionTicketStore(),
      pairedSessions,
      serverFqdn: SERVER_FQDN,
      username: "alice",
      now,
      certPin: () =>
        buildSignedCertStatus({
          serverDomain: SERVER_FQDN,
          certPem: CERT_PEM,
          certValidUntil: now() + 60 * 86_400_000,
          sign: (m) => ed.sign(m, stk),
          now,
        }),
    },
  });
  return { handle, pairedSessions, stkPub, now };
}

async function pairExtension(h: Awaited<ReturnType<typeof harness>>) {
  const mint = await h.handle(
    req({ method: "POST", path: "/api/screens/companion/mint-extension-ticket", headers: { "x-flagship-session": OWNER_TOKEN }, body: Buffer.from("{}") }),
  );
  expect(mint?.status).toBe(200);
  const ticket = JSON.parse(String(mint!.body)) as { ticketId: string; ticketSecret: string; scope?: string };
  expect(ticket.scope).toBe("extension");
  const redeem = await h.handle(
    req({
      method: "POST",
      path: "/api/companion/redeem",
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" },
      body: Buffer.from(JSON.stringify({ ticketId: ticket.ticketId, ticketSecret: ticket.ticketSecret })),
    }),
  );
  expect(redeem?.status).toBe(200);
  return JSON.parse(String(redeem!.body)) as { companionSessionToken: string; expiresAt: number; scope?: string };
}

describe("browser extension session", () => {
  it("redeems an extension ticket into a 30-day extension session", async () => {
    const clock = { t: 10_000 };
    const h = await harness(clock);
    const s = await pairExtension(h);
    expect(s.scope).toBe("extension");
    expect(s.expiresAt).toBe(10_000 + EXTENSION_SESSION_TTL_MS);
  });

  it("opens no paired-session API", async () => {
    const clock = { t: 10_000 };
    const h = await harness(clock);
    const s = await pairExtension(h);
    for (const path of ["/api/screens/server-detail", "/api/screens/companion/list", "/api/screens/paired-sessions/list"]) {
      const r = await h.handle(req({ path, headers: { "x-flagship-session": s.companionSessionToken } }));
      expect(r?.status, path).toBe(403);
    }
    const mint = await h.handle(
      req({ method: "POST", path: "/api/screens/companion/mint-ticket", headers: { "x-flagship-session": s.companionSessionToken }, body: Buffer.from("{}") }),
    );
    expect(mint?.status).toBe(403);
    const write = await h.handle(
      req({ method: "POST", path: "/api/companion/request-write", headers: { "x-flagship-session": s.companionSessionToken }, body: Buffer.from("{}") }),
    );
    expect([403, 503]).toContain(write?.status);
  });

  it("is listed to the owner as an extension and revoked like Remote", async () => {
    const clock = { t: Date.now() };
    const h = await harness(clock);
    const s = await pairExtension(h);
    const list = await h.handle(req({ path: "/api/screens/companion/list", headers: { "x-flagship-session": OWNER_TOKEN } }));
    const companions = (JSON.parse(String(list!.body)) as { companions: Array<{ tokenPrefix: string; kind: string; userAgent?: string }> }).companions;
    expect(companions).toHaveLength(1);
    expect(companions[0]!.kind).toBe("extension");
    expect(companions[0]!.userAgent).toContain("Firefox");
    const sessions = await h.handle(req({ path: "/api/screens/paired-sessions/list", headers: { "x-flagship-session": OWNER_TOKEN } }));
    const kinds = (JSON.parse(String(sessions!.body)) as { sessions: Array<{ kind: string }> }).sessions.map((x) => x.kind).sort();
    expect(kinds).toEqual(["device", "extension"]);

    const revoke = await h.handle(
      req({
        method: "POST",
        path: "/api/screens/companion/revoke",
        headers: { "x-flagship-session": OWNER_TOKEN },
        body: Buffer.from(JSON.stringify({ tokenPrefix: companions[0]!.tokenPrefix })),
      }),
    );
    expect(revoke?.status).toBe(200);
    const after = await h.handle(req({ path: "/api/companion/cert-pin", headers: { "x-flagship-session": s.companionSessionToken } }));
    expect(after?.status).toBe(401);
  });

  it("serves a fresh signed report the phone-pinned server key verifies", async () => {
    const clock = { t: 1_800_000_000_000 };
    const h = await harness(clock);
    const s = await pairExtension(h);
    const r = await h.handle(req({ path: "/api/companion/cert-pin", headers: { "x-flagship-session": s.companionSessionToken } }));
    expect(r?.status).toBe(200);
    expect(r?.headers?.["cache-control"]).toBe("no-store");
    const body = JSON.parse(String(r!.body)) as { report: Parameters<typeof verifyDaemonStatusReport>[0]; signatureHex: string };
    expect(body.report.serverDomain).toBe(SERVER_FQDN);
    expect(body.report.certSha256).toBe(CERT_SHA256);
    expect(body.report.appsServed).toEqual([]);
    expect(body.report.issuedAt).toBe(clock.t);
    expect(verifyDaemonStatusReport(body.report, Buffer.from(body.signatureHex, "hex"), h.stkPub)).toBe(true);
  });

  it("refuses the cert-pin route to owner and Remote sessions, and to an expired extension", async () => {
    const clock = { t: 10_000 };
    const h = await harness(clock);
    const owner = await h.handle(req({ path: "/api/companion/cert-pin", headers: { "x-flagship-session": OWNER_TOKEN } }));
    expect(owner?.status).toBe(401);
    const s = await pairExtension(h);
    clock.t += EXTENSION_SESSION_TTL_MS + 1;
    const expired = await h.handle(req({ path: "/api/companion/cert-pin", headers: { "x-flagship-session": s.companionSessionToken } }));
    expect(expired?.status).toBe(401);
  });

  it("refuses a Remote ticket's session on the cert-pin route", async () => {
    const clock = { t: 10_000 };
    const h = await harness(clock);
    const mint = await h.handle(
      req({ method: "POST", path: "/api/screens/companion/mint-ticket", headers: { "x-flagship-session": OWNER_TOKEN }, body: Buffer.from("{}") }),
    );
    const t = JSON.parse(String(mint!.body)) as { ticketId: string; ticketSecret: string };
    const redeem = await h.handle(req({ method: "POST", path: "/api/companion/redeem", body: Buffer.from(JSON.stringify(t)) }));
    const remote = JSON.parse(String(redeem!.body)) as { companionSessionToken: string; scope?: string };
    expect(remote.scope).toBeUndefined();
    const r = await h.handle(req({ path: "/api/companion/cert-pin", headers: { "x-flagship-session": remote.companionSessionToken } }));
    expect(r?.status).toBe(401);
  });
});

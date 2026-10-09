import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import type os from "node:os";
import {
  buildSignedLanHint,
  lanAddressesFromInterfaces,
  leafCertSha256,
  parseConnectRequest,
  startLanListener,
  type LanListener,
} from "../src/lanDirect.js";
import { buildScreensHttp } from "../src/screens/screensHttp.js";
import type { HttpRequest } from "../src/runtime.js";
import { checkLanHint, deriveSTK, deriveSWK, resolveMsgSigner } from "@flagship/protocol";

const ZONE = "home.alice.flagship.services";

const iface = (address: string, internal = false, family = address.includes(":") ? "IPv6" : "IPv4") =>
  ({ address, internal, family }) as os.NetworkInterfaceInfo;

describe("lanAddressesFromInterfaces", () => {
  it("keeps private LAN addresses and drops everything else", () => {
    const got = lanAddressesFromInterfaces({
      lo: [iface("127.0.0.1", true), iface("::1", true)],
      en0: [iface("192.168.1.20"), iface("fe80::1"), iface("fd12:3456::7")],
      eth1: [iface("203.0.113.5")],
      docker0: [iface("172.17.0.1")],
      "br-1a2b": [iface("172.18.0.1")],
      tailscale0: [iface("100.101.102.103")],
      wg0: [iface("10.8.0.2")],
      eth0: [iface("10.0.0.15")],
    });
    expect(got.sort()).toEqual(["10.0.0.15", "192.168.1.20", "fd12:3456::7"]);
  });
  it("returns nothing for a VPS with only a public address", () => {
    expect(lanAddressesFromInterfaces({ eth0: [iface("203.0.113.5")], lo: [iface("127.0.0.1", true)] })).toEqual([]);
  });
});

describe("parseConnectRequest", () => {
  it("allows the box itself and names under it, on 443 only", () => {
    expect(parseConnectRequest(`CONNECT ${ZONE}:443 HTTP/1.1\r\nHost: x`, ZONE)).toEqual({ ok: true, host: ZONE });
    expect(parseConnectRequest(`CONNECT photos.${ZONE}:443 HTTP/1.1`, ZONE)).toMatchObject({ ok: true });
    expect(parseConnectRequest(`CONNECT ${ZONE.toUpperCase()}:443 HTTP/1.0`, ZONE)).toMatchObject({ ok: true });
  });
  it("refuses other hosts, lookalikes, other ports and garbage", () => {
    expect(parseConnectRequest("CONNECT example.com:443 HTTP/1.1", ZONE)).toEqual({ ok: false, status: 403 });
    expect(parseConnectRequest(`CONNECT x${ZONE}:443 HTTP/1.1`, ZONE)).toEqual({ ok: false, status: 403 });
    expect(parseConnectRequest(`CONNECT ${ZONE}.evil.com:443 HTTP/1.1`, ZONE)).toEqual({ ok: false, status: 403 });
    expect(parseConnectRequest(`CONNECT ${ZONE}:22 HTTP/1.1`, ZONE)).toEqual({ ok: false, status: 403 });
    expect(parseConnectRequest(`GET / HTTP/1.1`, ZONE)).toEqual({ ok: false, status: 400 });
  });
});

describe("startLanListener (live sockets)", () => {
  let backend: net.Server;
  let lan: LanListener | null = null;
  let backendHits = 0;
  let backendPort = 0;

  async function setup(maxConnections?: number): Promise<number> {
    backendHits = 0;
    backend = net.createServer((s) => {
      backendHits++;
      s.on("data", (d) => s.write(Buffer.concat([Buffer.from("echo:"), d])));
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
    backendPort = (backend.address() as net.AddressInfo).port;
    lan = await startLanListener({
      port: 0,
      backendPort,
      zone: ZONE,
      listAddresses: () => ["127.0.0.1"],
      log: () => {},
      ...(maxConnections ? { maxConnections } : {}),
    });
    return lan.endpoints()[0]!.port;
  }
  afterEach(async () => {
    await lan?.close();
    lan = null;
    await new Promise<void>((r) => backend.close(() => r()));
  });

  const talk = (port: number, send: Buffer, until: (buf: string) => boolean) =>
    new Promise<string>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () => c.write(send));
      let got = "";
      c.on("data", (d) => {
        got += d.toString("latin1");
        if (until(got)) {
          c.destroy();
          resolve(got);
        }
      });
      c.on("close", () => resolve(got));
    });

  it("reports the port it actually bound", async () => {
    const port = await setup();
    expect(port).toBeGreaterThan(0);
  });

  it("pipes a raw TLS stream (first byte 0x16) to the backend byte-for-byte", async () => {
    const port = await setup();
    const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5]);
    const got = await talk(port, hello, (g) => g.length >= 5 + hello.length);
    expect(Buffer.from(got, "latin1")).toEqual(Buffer.concat([Buffer.from("echo:"), hello]));
  });

  it("answers an in-zone CONNECT with 200 and then pipes", async () => {
    const port = await setup();
    const got = await talk(
      port,
      Buffer.from(`CONNECT photos.${ZONE}:443 HTTP/1.1\r\nHost: photos.${ZONE}:443\r\n\r\nhello`),
      (g) => g.includes("echo:hello"),
    );
    expect(got.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true);
    expect(got).toContain("echo:hello");
  });

  it("refuses an out-of-zone CONNECT without ever reaching the backend", async () => {
    const port = await setup();
    const got = await talk(port, Buffer.from("CONNECT example.com:443 HTTP/1.1\r\n\r\n"), () => false);
    expect(got.startsWith("HTTP/1.1 403")).toBe(true);
    expect(backendHits).toBe(0);
  });

  it("drops connections beyond the cap", async () => {
    const port = await setup(1);
    const first = net.connect(port, "127.0.0.1");
    await new Promise((r) => first.once("connect", r));
    await new Promise((r) => setTimeout(r, 20));
    const closed = await new Promise<boolean>((resolve) => {
      const second = net.connect(port, "127.0.0.1");
      second.on("close", () => resolve(true));
      second.on("data", () => resolve(false));
      setTimeout(() => resolve(false), 1000);
    });
    first.destroy();
    expect(closed).toBe(true);
  });
});

const REAL_CERT_PEM = `-----BEGIN CERTIFICATE-----
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

describe("buildSignedLanHint", () => {
  const stk = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(7) }, ZONE));
  const sign = resolveMsgSigner(stk);

  it("signs a hint the device-side check accepts, bound to the live cert", () => {
    const signed = buildSignedLanHint({
      serverDomain: ZONE,
      certPem: REAL_CERT_PEM,
      endpoints: [{ address: "192.168.1.20", port: 443 }],
      sign,
      now: 1_000_000,
    })!;
    const cert = leafCertSha256(REAL_CERT_PEM)!;
    expect(signed.hint.certSha256).toBe(cert);
    const r = checkLanHint(signed.hint, Buffer.from(signed.signatureHex, "hex"), stk.publicKey, {
      serverDomain: ZONE,
      certSha256: cert,
      now: 1_000_001,
    });
    expect(r).toEqual({ ok: true });
  });

  it("offers nothing without a LAN address or without a cert", () => {
    expect(buildSignedLanHint({ serverDomain: ZONE, certPem: REAL_CERT_PEM, endpoints: [], sign })).toBeNull();
    expect(
      buildSignedLanHint({ serverDomain: ZONE, certPem: null, endpoints: [{ address: "10.0.0.2", port: 443 }], sign }),
    ).toBeNull();
  });
});

describe("GET /api/screens/lan-hint", () => {
  const gate = {
    has: (t: string) => t === "tok",
    check: (r: HttpRequest) =>
      r.headers["x-flagship-session"] === "tok"
        ? null
        : { status: 401, headers: {}, body: JSON.stringify({ error: "unauthorized" }) },
  };
  const req = (token?: string): HttpRequest => ({
    method: "GET",
    path: "/api/screens/lan-hint",
    headers: token ? { "x-flagship-session": token } : {},
    body: Buffer.alloc(0),
  });
  const base = { serverFqdn: ZONE, username: "alice", daemonVersion: "t", startedAt: 1 };

  it("is behind the paired-session gate", async () => {
    const h = buildScreensHttp({ ...base, gate, lanHint: () => ({ hint: {} as never, signatureHex: "00" }) });
    expect((await h(req()))!.status).toBe(401);
  });
  it("returns 204 when the box has no hint, 200 with the signed hint otherwise", async () => {
    expect((await buildScreensHttp({ ...base, gate, lanHint: () => null })(req("tok")))!.status).toBe(204);
    const signed = { hint: { serverDomain: ZONE } as never, signatureHex: "ab" };
    const r = await buildScreensHttp({ ...base, gate, lanHint: () => signed })(req("tok"));
    expect(r!.status).toBe(200);
    expect(JSON.parse(String(r!.body))).toEqual(signed);
  });
});

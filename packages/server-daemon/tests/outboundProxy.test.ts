import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveIRK, signBoxProxy, type BoxProxy } from "@flagship/protocol";
import { openProxiedSocket, ProxyError } from "../src/outboundProxy/connect.js";
import { isDirectHost, OutboundNet } from "../src/outboundProxy/outboundNet.js";
import { startOutboundBridge } from "../src/outboundProxy/bridge.js";
import { OutboundProxyStore, settingOf } from "../src/outboundProxy/store.js";
import { buildOutboundProxyHttp, OUTBOUND_PROXY_PATH } from "../src/outboundProxy/http.js";
import { buildCurlrc } from "../src/outboundProxy/curlrc.js";
import { buildHealthReportScript } from "../src/healthReporter.js";
import { execFileSync } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { X509CertificateGenerator, SubjectAlternativeNameExtension, cryptoProvider } from "@peculiar/x509";

cryptoProvider.set(webcrypto as unknown as Crypto);

async function selfSigned(name: string) {
  const keys = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys,
    extensions: [new SubjectAlternativeNameExtension([{ type: "dns", value: name }])],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  return { cert: cert.toString("pem"), key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n` };
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** A TCP echo server that also answers HTTP GETs with the path. */
async function target(): Promise<number> {
  const s = createHttpServer((req, res) => res.end(`hello ${req.url}`));
  const port = await listen(s);
  closers.push(() => s.close());
  return port;
}

/** A minimal SOCKS5 server; every request is connected to `to` whatever it names. */
async function socks5(to: number, creds?: { u: string; p: string }) {
  const seen: Array<{ atyp: number; host: string; port: number }> = [];
  const s = createServer((c: Socket) => {
    let buf = Buffer.alloc(0);
    let stage = "greet";
    c.on("error", () => {});
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === "greet" && buf.length >= 2 && buf.length >= 2 + buf[1]!) {
        const methods = [...buf.subarray(2, 2 + buf[1]!)];
        buf = buf.subarray(2 + buf[1]!);
        if (creds) {
          if (!methods.includes(2)) return void c.end(Buffer.from([5, 0xff]));
          c.write(Buffer.from([5, 2]));
          stage = "auth";
        } else {
          c.write(Buffer.from([5, 0]));
          stage = "req";
        }
      }
      if (stage === "auth" && buf.length >= 2) {
        const ul = buf[1]!;
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul]!;
        if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString();
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        const ok = u === creds!.u && p === creds!.p;
        c.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return void c.end();
        stage = "req";
      }
      if (stage === "req" && buf.length >= 5) {
        const atyp = buf[3]!;
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4]!;
        if (buf.length < 4 + len + 2) return;
        const host = atyp === 3 ? buf.subarray(5, 5 + buf[4]!).toString() : [...buf.subarray(4, 4 + len)].join(".");
        const port = buf.readUInt16BE(4 + len);
        seen.push({ atyp, host, port });
        const rest = buf.subarray(4 + len + 2);
        stage = "pipe";
        c.removeAllListeners("data");
        const up = connect(to, "127.0.0.1", () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          c.pipe(up);
          up.pipe(c);
        });
        up.on("error", () => c.destroy());
      }
    });
  });
  const port = await listen(s);
  closers.push(() => s.close());
  return { port, seen };
}

/** A minimal HTTP CONNECT proxy that connects every request to `to`. */
async function httpConnectProxy(to: number, auth?: string) {
  const targets: string[] = [];
  const s = createHttpServer();
  s.on("connect", (req, c: Socket, head) => {
    if (auth && req.headers["proxy-authorization"] !== `Basic ${Buffer.from(auth).toString("base64")}`) {
      c.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    targets.push(req.url ?? "");
    const up = connect(to, "127.0.0.1", () => {
      c.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      c.pipe(up);
      up.pipe(c);
    });
  });
  const port = await listen(s);
  closers.push(() => s.close());
  return { port, targets };
}

function getVia(sock: Socket, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ createConnection: () => sock, path, host: "example.test" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
    process.nextTick(() => sock.resume());
  });
}

async function deadPort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("openProxiedSocket", () => {
  it("connects through SOCKS5 by name (remote DNS)", async () => {
    const t = await target();
    const p = await socks5(t);
    const sock = await openProxiedSocket({ kind: "socks5", host: "127.0.0.1", port: p.port }, "example.test", 443);
    expect(await getVia(sock, "/a")).toBe("hello /a");
    expect(p.seen).toEqual([{ atyp: 3, host: "example.test", port: 443 }]);
  });

  it("authenticates to SOCKS5 and reports a refused password as auth", async () => {
    const t = await target();
    const p = await socks5(t, { u: "alice", p: "pw" });
    const ok = await openProxiedSocket({ kind: "socks5", host: "127.0.0.1", port: p.port, username: "alice", password: "pw" }, "x.test", 80);
    expect(await getVia(ok, "/b")).toBe("hello /b");
    await expect(
      openProxiedSocket({ kind: "socks5", host: "127.0.0.1", port: p.port, username: "alice", password: "no" }, "x.test", 80),
    ).rejects.toMatchObject({ code: "auth" });
    await expect(openProxiedSocket({ kind: "socks5", host: "127.0.0.1", port: p.port }, "x.test", 80)).rejects.toMatchObject({ code: "auth" });
  });

  it("connects through HTTP CONNECT with Basic auth", async () => {
    const t = await target();
    const p = await httpConnectProxy(t, "bob:secret");
    const sock = await openProxiedSocket({ kind: "http", host: "127.0.0.1", port: p.port, username: "bob", password: "secret" }, "example.test", 8443);
    expect(await getVia(sock, "/c")).toBe("hello /c");
    expect(p.targets).toEqual(["example.test:8443"]);
    await expect(openProxiedSocket({ kind: "http", host: "127.0.0.1", port: p.port }, "example.test", 443)).rejects.toMatchObject({ code: "auth" });
  });

  it("says unreachable when nothing listens", async () => {
    const port = await deadPort();
    const e = await openProxiedSocket({ kind: "socks5", host: "127.0.0.1", port }, "x.test", 443).catch((x) => x);
    expect(e).toBeInstanceOf(ProxyError);
    expect(e.code).toBe("unreachable");
  });
});

describe("isDirectHost", () => {
  it("keeps local and private destinations off the proxy", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.1.9", "172.20.0.1", "100.64.1.1", "::1", "fd00::1", "[fe80::1]", "localhost", "postgres", "nas.local", "host.flagship.internal"]) {
      expect(isDirectHost(h), h).toBe(true);
    }
    for (const h of ["flagshipserver.com", "8.8.8.8", "2606:4700::1111", "acme-v02.api.letsencrypt.org"]) {
      expect(isDirectHost(h), h).toBe(false);
    }
  });
});

describe("OutboundNet", () => {
  it("sends public hosts through the proxy and keeps state", async () => {
    const t = await target();
    const p = await socks5(t);
    const net = new OutboundNet();
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: p.port }, fallbackDirect: false });
    const sock = await net.connectTcp("api.example.com", 443);
    expect(await getVia(sock, "/d")).toBe("hello /d");
    expect(net.status().state).toBe("ok");
  });

  it("fails closed without fallback, and goes direct with it", async () => {
    const t = await target();
    const dead = await deadPort();
    const net = new OutboundNet();
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: dead }, fallbackDirect: false });
    await expect(net.connectTcp("api.example.com", 443)).rejects.toMatchObject({ code: "unreachable" });
    expect(net.status()).toMatchObject({ state: "failing", lastError: "Can't reach the proxy." });

    const openDirect = new OutboundNet({
      openProxied: () => Promise.reject(new ProxyError("unreachable", "Can't reach the proxy.")),
    });
    // Point "direct" at the local target so the fallback path is observable.
    const d = openDirect as unknown as { direct(h: string, p: number): Promise<Socket> };
    const realDirect = d.direct.bind(openDirect);
    const dialled: string[] = [];
    d.direct = (h, port) => {
      dialled.push(`${h}:${port}`);
      return realDirect("127.0.0.1", t);
    };
    openDirect.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: dead }, fallbackDirect: true });
    const viaDirect = await openDirect.connectTcp("api.example.com", 443);
    expect(await getVia(viaDirect, "/e")).toBe("hello /e");
    expect(dialled).toEqual(["api.example.com:443"]);
    expect(openDirect.status().state).toBe("fallback");
  });

  it("routes undici fetch through the proxy", async () => {
    const t = await target();
    const p = await socks5(t);
    const net = new OutboundNet();
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: p.port }, fallbackDirect: false });
    const res = await fetch("http://api.example.com/f", { dispatcher: net.dispatcher() } as RequestInit);
    expect(await res.text()).toBe("hello /f");
    expect(p.seen[0]).toMatchObject({ host: "api.example.com", port: 80 });
  });

  it("carries a ws WebSocket through the proxy via its agent", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    closers.push(() => wss.close());
    wss.on("connection", (s) => s.on("message", (m) => s.send(`echo ${m}`)));
    const p = await socks5((wss.address() as AddressInfo).port);
    const net = new OutboundNet();
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: p.port }, fallbackDirect: false });
    const ws = new WebSocket("ws://hub.example.org:8443/tunnel", { agent: net.httpAgent() });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once("open", () => ws.send("hi"));
      ws.once("message", (m) => resolve(String(m)));
      ws.once("error", reject);
    });
    ws.close();
    expect(reply).toBe("echo hi");
    expect(p.seen[0]).toMatchObject({ host: "hub.example.org", port: 8443 });
  });

  it("speaks TLS end to end through the proxy (https agent)", async () => {
    const tls = await selfSigned("hub.example.org");
    const srv = createHttpsServer({ cert: tls.cert, key: tls.key }, (req, res) => res.end(`tls ${req.url}`));
    const port = await listen(srv as unknown as Server);
    closers.push(() => srv.close());
    const p = await socks5(port);
    const net = new OutboundNet();
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: p.port }, fallbackDirect: false });
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest({ host: "hub.example.org", path: "/h", agent: net.httpsAgent(), ca: tls.cert }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("tls /h");
    expect(p.seen[0]).toMatchObject({ host: "hub.example.org", port: 443 });
  });

  it("gives child processes the bridge only while a proxy is set", () => {
    const net = new OutboundNet();
    net.setBridgeUrl("http://127.0.0.1:1234");
    expect(net.childEnv({ PATH: "/bin", HTTPS_PROXY: "http://evil" }).HTTPS_PROXY).toBeUndefined();
    net.configure({ upstream: { kind: "http", host: "10.0.0.2", port: 3128 }, fallbackDirect: false });
    const env = net.childEnv({ PATH: "/bin" });
    expect(env).toMatchObject({ PATH: "/bin", HTTPS_PROXY: "http://127.0.0.1:1234", http_proxy: "http://127.0.0.1:1234" });
  });
});

describe("the loopback bridge", () => {
  it("forwards CONNECT and absolute-form requests through the proxy", async () => {
    const t = await target();
    const p = await socks5(t);
    const net = new OutboundNet();
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: p.port }, fallbackDirect: false });
    const bridge = await startOutboundBridge(net);
    closers.push(() => void bridge.close());
    const bport = Number(new URL(bridge.url).port);

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: bport, path: "http://deb.example.org/dists/x", headers: { host: "deb.example.org" } }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("hello /dists/x");

    const tunnel = await new Promise<Socket>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: bport, method: "CONNECT", path: "registry.example.org:443" });
      req.on("connect", (_res, sock) => resolve(sock));
      req.on("error", reject);
      req.end();
    });
    expect(await getVia(tunnel, "/g")).toBe("hello /g");
    expect(p.seen.map((s) => s.host)).toEqual(["deb.example.org", "registry.example.org"]);
  });
});

describe("the outbound proxy store and endpoint", () => {
  const irk = deriveIRK({ seed: new Uint8Array(32).fill(0x2a) });
  const other = deriveIRK({ seed: new Uint8Array(32).fill(0x2b) });
  const serverDomain = "home.plucky-avocet.flagship.services";
  const authority = { serverDomain, username: "plucky-avocet", ownerIrkPub: irk.publicKey };
  const NOW = 1_760_000_000_000;
  const order = (over: Partial<BoxProxy> = {}): BoxProxy => ({
    serverDomain,
    kind: "socks5",
    host: "proxy.example.net",
    port: 1080,
    auth: false,
    fallbackDirect: false,
    issuedAt: NOW,
    nonce: "ab".repeat(32),
    ...over,
  });
  const dir = () => mkdtempSync(join(tmpdir(), "outbound-proxy-"));

  it("adopts the recipe's order at first boot, with credentials, and saves it 0600", async () => {
    const d = dir();
    const p = order({ auth: true });
    writeFileSync(
      join(d, "install-blob.json"),
      JSON.stringify({
        serverDomain,
        outboundProxy: { proxy: p, signature: signBoxProxy(p, irk) },
        outboundProxyCredentials: { username: "alice", password: "pw" },
      }),
    );
    const store = new OutboundProxyStore(join(d, "outbound-proxy.json"), authority);
    const got = await store.adoptFromInstallBlob(join(d, "install-blob.json"));
    expect(got?.source).toBe("recipe");
    expect(settingOf(got)).toEqual({
      upstream: { kind: "socks5", host: "proxy.example.net", port: 1080, username: "alice", password: "pw" },
      fallbackDirect: false,
    });
    expect(statSync(join(d, "outbound-proxy.json")).mode & 0o777).toBe(0o600);
    const again = new OutboundProxyStore(join(d, "outbound-proxy.json"), authority);
    expect((await again.load())?.signed.proxy).toEqual(p);
  });

  it("ignores a recipe order signed by someone else or for another box", async () => {
    const d = dir();
    const forged = order();
    const elsewhere = order({ serverDomain: "work.plucky-avocet.flagship.services" });
    for (const [o, key] of [[forged, other], [elsewhere, irk]] as const) {
      writeFileSync(join(d, "install-blob.json"), JSON.stringify({ outboundProxy: { proxy: o, signature: signBoxProxy(o, key) } }));
      const store = new OutboundProxyStore(join(d, "outbound-proxy.json"), authority);
      expect(await store.adoptFromInstallBlob(join(d, "install-blob.json"))).toBeNull();
    }
  });

  function endpoint(probeResult: string | null, now = NOW) {
    const d = dir();
    const store = new OutboundProxyStore(join(d, "outbound-proxy.json"), authority);
    const net = new OutboundNet();
    net.probe = async () => probeResult;
    const activated: unknown[] = [];
    const handle = buildOutboundProxyHttp({
      store,
      net,
      authority,
      probeTarget: () => ({ host: "hub.example", port: 8443 }),
      activate: (s) => void activated.push(s),
      now: () => now,
      switchDelayMs: 0,
    });
    const post = (body: unknown, companion = false) =>
      handle(OUTBOUND_PROXY_PATH, "POST", { method: "POST", path: OUTBOUND_PROXY_PATH, headers: {}, body: Buffer.from(JSON.stringify(body)) }, { companion });
    const get = () => handle(OUTBOUND_PROXY_PATH, "GET", { method: "GET", path: OUTBOUND_PROXY_PATH, headers: {}, body: Buffer.alloc(0) }, { companion: true });
    return { d, store, net, post, get, activated };
  }

  it("applies a signed, tested change and never returns the password", async () => {
    const e = endpoint(null);
    const p = order({ auth: true, kind: "http", port: 3128 });
    const r = await e.post({ proxy: p, signature: signBoxProxy(p, irk), credentials: { username: "alice", password: "pw" } });
    expect(r?.status).toBe(200);
    expect(String(r?.body)).not.toContain("pw");
    await new Promise((res) => setTimeout(res, 5));
    expect(e.activated).toHaveLength(1);
    const g = JSON.parse(String((await e.get())?.body));
    expect(g).toMatchObject({ proxy: { kind: "http", host: "proxy.example.net", port: 3128, auth: true }, hasCredentials: true });
    expect(JSON.stringify(g)).not.toContain("pw");
    expect(readFileSync(join(e.d, "outbound-proxy.json"), "utf-8")).toContain('"password":"pw"');

    // Same proxy, no credentials sent: the stored ones are kept.
    const p2 = { ...p, fallbackDirect: true, issuedAt: NOW + 1 };
    const r2 = await e.post({ proxy: p2, signature: signBoxProxy(p2, irk) });
    expect(r2?.status).toBe(200);
    expect(e.store.current()?.credentials).toEqual({ username: "alice", password: "pw" });

    // Turning it off.
    const off = order({ kind: "none", host: "", port: 0, issuedAt: NOW + 2 });
    expect((await e.post({ proxy: off, signature: signBoxProxy(off, irk) }))?.status).toBe(200);
    expect(JSON.parse(String((await e.get())?.body)).proxy).toBeNull();
  });

  it("refuses companions, forgeries, stale or replayed orders, and missing credentials", async () => {
    const e = endpoint(null);
    const p = order();
    const sig = signBoxProxy(p, irk);
    expect((await e.post({ proxy: p, signature: sig }, true))?.status).toBe(403);
    expect((await e.post({ proxy: p, signature: signBoxProxy(p, other) }))?.status).toBe(403);
    const old = order({ issuedAt: NOW - 11 * 60_000 });
    expect((await e.post({ proxy: old, signature: signBoxProxy(old, irk) }))?.status).toBe(403);
    expect((await e.post({ proxy: p, signature: sig }))?.status).toBe(200);
    expect((await e.post({ proxy: p, signature: sig }))?.status).toBe(409);
    const needs = order({ auth: true, host: "other.example.net", issuedAt: NOW + 5 });
    const r = await e.post({ proxy: needs, signature: signBoxProxy(needs, irk) });
    expect(r?.status).toBe(400);
    expect(JSON.parse(String(r?.body)).error).toBe("Enter the proxy's username and password.");
  });

  it("keeps the old setting when the new proxy fails its test", async () => {
    const e = endpoint("Can't reach the proxy.");
    const p = order();
    const r = await e.post({ proxy: p, signature: signBoxProxy(p, irk) });
    expect(r?.status).toBe(422);
    expect(JSON.parse(String(r?.body)).error).toBe("Can't reach the proxy.");
    expect(e.store.current()).toBeNull();
    expect(e.activated).toHaveLength(0);
  });
});

describe("the proxy curl config for scripts outside the daemon", () => {
  it("names the proxy with remote DNS and quotes the credentials", () => {
    expect(buildCurlrc({ upstream: { kind: "socks5", host: "2001:db8::7", port: 9050 }, fallbackDirect: false })).toBe(
      'proxy = "socks5h://[2001:db8::7]:9050"\n',
    );
    expect(
      buildCurlrc({ upstream: { kind: "http", host: "proxy.example.net", port: 3128, username: "al", password: 'p"w\\x' }, fallbackDirect: true }),
    ).toBe('proxy = "http://proxy.example.net:3128"\nproxy-user = "al:p\\"w\\\\x"\n');
  });

  it("the health script uses it when present and stays valid bash", () => {
    const script = buildHealthReportScript({ controlPlaneBaseUrl: "https://flagshipserver.com", serverDomain: "home.a.flagship.services" });
    expect(script).toContain("[ -r /var/flagship/outbound-proxy.curlrc ] && proxy=(-K /var/flagship/outbound-proxy.curlrc)");
    const d = mkdtempSync(join(tmpdir(), "health-"));
    writeFileSync(join(d, "h.sh"), script);
    execFileSync("bash", ["-n", join(d, "h.sh")]);
  });
});

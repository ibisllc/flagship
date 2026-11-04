import "reflect-metadata";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcmeAccount, KeydClient, KeydServer, KeydService, TlsKeys } from "@flagship/keyd";
import { KeydAcmeIssuer } from "../src/acme/keydAcme.js";
import { keydAcmeApi } from "../src/keydAsync.js";
import { MockAcme } from "./helpers/mockAcme.js";
import { startLanListener, type LanListener } from "../src/lanDirect.js";
import { cameViaLan, LanIngressPorts, refuseRescueOffLan } from "../src/lanIngress.js";
import { _handleHttpConnectionForTest } from "../src/runtime.js";
import { listenForFrontend } from "../src/tlsUpstream.js";

const FQDN = "home.alice.flagship.services";
const hasGo = spawnSync("go", ["version"]).status === 0;
const d = hasGo ? describe : describe.skip;

let dir: string;
let server: KeydServer;
let client: KeydClient;
let frontend: ChildProcess;
let upstream: Server;
let port = 0;
let caPem = "";
let bin = "";
let keydSock = "";
const seen: Array<{ header: string; body: string }> = [];

beforeAll(async () => {
  if (!hasGo) return;
  dir = mkdtempSync(join(tmpdir(), "tlsd-"));
  bin = join(dir, "flagship-tlsd");
  execFileSync("go", ["build", "-o", bin, "."], { cwd: new URL("../../../installer/tls-frontend", import.meta.url).pathname, env: { ...process.env, CGO_ENABLED: "0" } });
  const tls = new TlsKeys(new Set([FQDN, `*.${FQDN}`]), join(dir, "tls"));
  const acct = new AcmeAccount(tls, new Set(["acme.test"]), join(dir, "acme.key"));
  const sock = join(dir, "k.sock");
  keydSock = sock;
  server = new KeydServer({ socketPath: sock, service: new KeydService({ identitySeed: new Uint8Array(32).fill(3), tls, acme: acct }), rateLimits: { "*": { perSecond: 10000, burst: 10000 } } });
  await server.start();
  client = new KeydClient({ socketPath: sock, component: "acme" });
  await client.connect();
  const mock = new MockAcme();
  const issuer = new KeydAcmeIssuer({
    keyd: keydAcmeApi(client), directoryUrl: "https://acme.test/directory", email: "ops@example.com", fetchImpl: mock.fetch,
    dns: { publishTxt: async (host, value) => ((mock.txt.get(host) ?? mock.txt.set(host, new Set()).get(host)!).add(value), async () => void mock.txt.get(host)?.delete(value)) },
    dns01PropagationDelayMs: 0, pollIntervalMs: 1,
  });
  const out = await issuer.issue([FQDN, `*.${FQDN}`]);
  await client.call("tls.activate", { handle: out.handle });
  caPem = out.chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)![1]!;

  const upSock = join(dir, "u.sock");
  upstream = createServer((c) => {
    let buf = "";
    c.on("data", (b) => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0 && buf.length > nl + 1) {
        seen.push({ header: buf.slice(0, nl), body: buf.slice(nl + 1) });
        c.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
        c.end();
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(upSock, () => r()));

  ({ child: frontend, port } = await spawnFrontend(upSock));
}, 60_000);

async function spawnFrontend(upSock: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(bin, ["--listen", "127.0.0.1:0", "--keyd", keydSock, "--upstream", upSock, "--refresh", "100ms"], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.on("data", (b: Buffer) => {
      const m = /listening 127\.0\.0\.1:(\d+)/.exec(b.toString());
      if (m) resolve(Number(m[1]));
    });
    child.once("error", reject);
    setTimeout(() => reject(new Error("frontend did not start")), 8000);
  });
  return { child, port };
}

afterAll(async () => {
  if (!hasGo) return;
  frontend?.kill();
  upstream?.close();
  client?.close();
  await server?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function request(servername: string, host = servername, maxVersion?: "TLSv1.2"): Promise<{ status: string; header: string }> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: "127.0.0.1", port, servername, ca: caPem, ALPNProtocols: ["http/1.1"], ...(maxVersion ? { maxVersion } : {}) }, () => {
      s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    });
    let out = "";
    s.on("data", (b) => (out += b.toString()));
    s.on("end", () => resolve({ status: out.split("\r\n")[0] ?? "", header: seen.at(-1)?.header ?? "" }));
    s.on("error", reject);
  });
}

d("the Go TLS frontend with a real keyd", () => {
  it("serves a certificate whose key only keyd has, and hands the daemon plain text with the SNI", async () => {
    const r = await request(`chess.${FQDN}`);
    expect(r.status).toBe("HTTP/1.1 200 OK");
    const h = JSON.parse(r.header);
    expect(h).toMatchObject({ sni: `chess.${FQDN}`, alpn: "http/1.1" });
    expect(seen.at(-1)!.body).toContain("GET / HTTP/1.1");
  });

  it("signs TLS 1.3 CertificateVerify and TLS 1.2 ServerKeyExchange through keyd's structured tls.sign", async () => {
    expect(JSON.parse((await request(`chess.${FQDN}`)).header)).toMatchObject({ tls: "1.3" });
    expect(JSON.parse((await request(`chess.${FQDN}`, `chess.${FQDN}`, "TLSv1.2")).header)).toMatchObject({ tls: "1.2" });
  });

  it("serves the apex too and refuses a name the certificate does not cover", async () => {
    expect((await request(FQDN)).status).toBe("HTTP/1.1 200 OK");
    await expect(request("evil.example.com")).rejects.toThrow();
  });

  it("the daemon-side process holds no private key: only keyd's handle exists", async () => {
    const listed = JSON.stringify(await client.call("tls.list"));
    expect(listed).not.toMatch(/priv/i);
    expect(existsSync(join(dir, "tls"))).toBe(true);
  });
});

// A box whose TLS key keyd holds (classic or arch-v2 without the Rust proxy) runs this Go frontend: the LAN listener
// dials it, it dials the daemon's Unix socket, and only the header's `peer` lets the daemon see which one it was.
d("rescue behind the Go TLS frontend: LAN-direct answers, the relay path is a 404", () => {
  it("marks a LAN-direct connection by its loopback port and refuses the same request dialled straight in", async () => {
    const ports = new LanIngressPorts();
    const daemonSock = join(dir, "d.sock");
    const daemon = await listenForFrontend(daemonSock, (socket) => {
      const viaLan = cameViaLan(socket, ports);
      _handleHttpConnectionForTest(socket, async (r) => refuseRescueOffLan(r, viaLan) ?? { status: 200, headers: { "content-type": "text/plain" }, body: `rescue:${r.path}` });
    });
    const fe = await spawnFrontend(daemonSock);
    let lan: LanListener | null = null;
    try {
      lan = await startLanListener({ port: 0, backendPort: fe.port, zone: FQDN, listAddresses: () => ["127.0.0.1"], log: () => {}, lanPorts: ports });
      const lanPort = lan.endpoints()[0]!.port;
      const post = (to: number, path: string, extra = "") =>
        new Promise<string>((resolve, reject) => {
          const s = tlsConnect({ host: "127.0.0.1", port: to, servername: FQDN, ca: caPem, ALPNProtocols: ["http/1.1"] }, () => {
            s.write(`POST ${path} HTTP/1.1\r\nHost: ${FQDN}\r\n${extra}content-length: 0\r\nconnection: close\r\n\r\n`);
          });
          let out = "";
          s.on("data", (b) => (out += b.toString()));
          s.on("end", () => resolve(out));
          s.on("error", reject);
        });
      const lanAnswer = await post(lanPort, "/api/rescue/hello");
      expect(lanAnswer.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
      expect(lanAnswer).toContain("rescue:/api/rescue/hello");
      // Straight into the frontend, as the relay tunnel delivers it: a 404, whatever the client claims.
      const relayed = await post(fe.port, "/api/rescue/hello", "x-flagship-ingress: lan\r\nx-forwarded-for: 192.168.1.5\r\n");
      expect(relayed.split("\r\n")[0]).toMatch(/^HTTP\/1\.1 404/);
      expect(relayed).toContain("not found");
      expect((await post(fe.port, "/api/health")).split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    } finally {
      await lan?.close();
      fe.child.kill();
      await new Promise<void>((r) => daemon.close(() => r()));
    }
  }, 30_000);
});

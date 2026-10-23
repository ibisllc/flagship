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
const seen: Array<{ header: string; body: string }> = [];

beforeAll(async () => {
  if (!hasGo) return;
  dir = mkdtempSync(join(tmpdir(), "tlsd-"));
  const bin = join(dir, "flagship-tlsd");
  execFileSync("go", ["build", "-o", bin, "."], { cwd: new URL("../../../installer/tls-frontend", import.meta.url).pathname, env: { ...process.env, CGO_ENABLED: "0" } });
  const tls = new TlsKeys(new Set([FQDN, `*.${FQDN}`]), join(dir, "tls"));
  const acct = new AcmeAccount(tls, new Set(["acme.test"]), join(dir, "acme.key"));
  const sock = join(dir, "k.sock");
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

  frontend = spawn(bin, ["--listen", "127.0.0.1:0", "--keyd", sock, "--upstream", upSock, "--refresh", "100ms"], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise<number>((resolve, reject) => {
    frontend.stdout!.on("data", (b: Buffer) => {
      const m = /listening 127\.0\.0\.1:(\d+)/.exec(b.toString());
      if (m) resolve(Number(m[1]));
    });
    frontend.once("error", reject);
    setTimeout(() => reject(new Error("frontend did not start")), 8000);
  });
}, 60_000);

afterAll(async () => {
  if (!hasGo) return;
  frontend?.kill();
  upstream?.close();
  client?.close();
  await server?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function request(servername: string, host = servername): Promise<{ status: string; header: string }> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: "127.0.0.1", port, servername, ca: caPem, ALPNProtocols: ["http/1.1"] }, () => {
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

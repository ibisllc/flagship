import "reflect-metadata";
import { webcrypto } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { X509CertificateGenerator, SubjectAlternativeNameExtension, cryptoProvider } from "@peculiar/x509";
import { makeLanFetch } from "../src/appCopy/lanFetch.js";

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

const SRC = "home.harry.flagship.services";
const servers: https.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(name: string) {
  const tls = await selfSigned(name);
  const seen: Array<{ host?: string; sni?: string; body: string }> = [];
  const srv = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ host: req.headers.host, sni: (req.socket as { servername?: string }).servername, body });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("chunk-bytes"));
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { port: (srv.address() as AddressInfo).port, ca: tls.cert, seen };
}

const init = { method: "POST", headers: { "content-type": "application/json" }, body: '{"part":"image"}' };

describe("fetching from the source over the LAN", () => {
  it("connects to the LAN address but speaks TLS and HTTP as the source's own name", async () => {
    const s = await serve(SRC);
    const f = makeLanFetch({ ca: s.ca });
    const res = await f({ address: "127.0.0.1", port: s.port }, `https://${SRC}/api/app-copy/export`, init);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("chunk-bytes");
    expect(s.seen).toEqual([{ host: SRC, sni: SRC, body: '{"part":"image"}' }]);
    // A second request reuses the kept-alive connection without tripping the connect timer.
    const again = await f({ address: "127.0.0.1", port: s.port }, `https://${SRC}/api/app-copy/export`, init);
    expect(again.status).toBe(200);
  });

  it("refuses whatever holds that address when it can't prove it is the source", async () => {
    const s = await serve("printer.local");
    const f = makeLanFetch({ ca: s.ca });
    await expect(f({ address: "127.0.0.1", port: s.port }, `https://${SRC}/api/app-copy/export`, init)).rejects.toThrow(/altnames|hostname|match/i);
    expect(s.seen).toEqual([]);
  });

  it("gives up quickly on an address that doesn't answer", async () => {
    const f = makeLanFetch({ connectTimeoutMs: 200 });
    const t0 = Date.now();
    // TEST-NET-1 is never routed, so the connect hangs until the timer.
    await expect(f({ address: "192.0.2.1", port: 443 }, `https://${SRC}/api/app-copy/export`, init)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

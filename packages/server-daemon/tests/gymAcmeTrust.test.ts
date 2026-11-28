import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { GYM_ACME_ROOT_URLS, addGymAcmeRoots } from "../src/gymAcmeTrust.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
async function cert(name: string, ca: boolean): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const c = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: String(Math.floor(Math.random() * 1e9) + 1),
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(ca, undefined, true)],
  });
  return c.toString("pem");
}

function fakeTls(initial: string[]) {
  let list = [...initial];
  return {
    api: { getCACertificates: () => list, setDefaultCACertificates: (c: string[]) => void (list = c) } as never,
    list: () => list,
  };
}
const serve = (pems: Record<string, string>) => (async (u: RequestInfo | URL) => new Response(pems[String(u)] ?? "", { status: pems[String(u)] ? 200 : 404 })) as typeof fetch;

describe("gym boxes trust the gym's Pebble root (gym branch only)", () => {
  it("adds the root and intermediate to Node's default CA list, once, and keeps earlier ones", async () => {
    const sys = await cert("System Root", true);
    const [root, inter] = [await cert("Pebble Root CA", true), await cert("Pebble Intermediate CA", true)];
    const t = fakeTls([sys]);
    const pems = { [GYM_ACME_ROOT_URLS[0]!]: root, [GYM_ACME_ROOT_URLS[1]!]: inter };
    expect(await addGymAcmeRoots({ tlsApi: t.api, fetchImpl: serve(pems) })).toBe(2);
    expect(t.list()).toHaveLength(3);
    expect(await addGymAcmeRoots({ tlsApi: t.api, fetchImpl: serve(pems) })).toBe(0);
    const root2 = await cert("Pebble Root CA", true);
    expect(await addGymAcmeRoots({ tlsApi: t.api, fetchImpl: serve({ ...pems, [GYM_ACME_ROOT_URLS[0]!]: root2 }) })).toBe(1);
    expect(t.list()).toHaveLength(4);
  });

  it("refuses a leaf and adds nothing", async () => {
    const t = fakeTls([]);
    const pems = { [GYM_ACME_ROOT_URLS[0]!]: await cert("evil.example", false), [GYM_ACME_ROOT_URLS[1]!]: await cert("Pebble Intermediate CA", true) };
    await expect(addGymAcmeRoots({ tlsApi: t.api, fetchImpl: serve(pems) })).rejects.toThrow(/not a CA/);
    expect(t.list()).toHaveLength(0);
  });

  it("does nothing on a Node without setDefaultCACertificates", async () => {
    const logs: string[] = [];
    expect(await addGymAcmeRoots({ tlsApi: {} as never, log: (m) => logs.push(m) })).toBe(0);
    expect(logs[0]).toMatch(/cannot extend/);
  });
});

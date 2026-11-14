import "reflect-metadata";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import {
  LETS_ENCRYPT_PRODUCTION,
  expectedIssuer,
  isLetsEncryptProduction,
  mergeRootsFile,
  pemFingerprint,
  readIssuanceCa,
  runIsOnLetsEncrypt,
  splitPems,
  testCaRootUrls,
} from "../lib/acmeCa.js";
import { REEXEC_ENV, prepareAcmeTrust, testCaRootUnchanged } from "../lib/acmeTrust.js";

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
  return `${c.toString("pem")}\n`;
}

const PEBBLE = "https://flagship-acme-gym.fly.dev/dir";
const CONTROL = "gym.flagshipserver.com";

function fakeCa(state: { directory: string | null; status?: number; root: string; intermediate: string }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `https://${CONTROL}/api/certificates/account`) {
      if (state.status && state.status !== 200) return new Response("{}", { status: state.status });
      return Response.json({ directory: state.directory, accountUri: "https://ca/acct/1", thumbprint: "t" });
    }
    if (url === "https://flagship-acme-gym.fly.dev/roots/0") return new Response(state.root);
    if (url === "https://flagship-acme-gym.fly.dev/intermediates/0") return new Response(state.intermediate);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("which CA the gym issues from", () => {
  it("recognises only Let's Encrypt production as Let's Encrypt", () => {
    expect(isLetsEncryptProduction(LETS_ENCRYPT_PRODUCTION)).toBe(true);
    expect(isLetsEncryptProduction("https://acme-staging-v02.api.letsencrypt.org/directory")).toBe(false);
    expect(isLetsEncryptProduction(PEBBLE)).toBe(false);
    expect(isLetsEncryptProduction("http://acme-v02.api.letsencrypt.org/directory")).toBe(false);
    expect(isLetsEncryptProduction("")).toBe(false);
    expect(isLetsEncryptProduction("not a url")).toBe(false);
  });

  it("reads the directory .com reports, defaulting to Let's Encrypt like .com does", async () => {
    const root = await cert("Pebble Root CA", true);
    expect(await readIssuanceCa(CONTROL, fakeCa({ directory: PEBBLE, root, intermediate: root }))).toMatchObject({ directory: PEBBLE, letsEncrypt: false });
    expect(await readIssuanceCa(CONTROL, fakeCa({ directory: null, root, intermediate: root }))).toMatchObject({ directory: LETS_ENCRYPT_PRODUCTION, letsEncrypt: true });
    expect(await readIssuanceCa(CONTROL, fakeCa({ directory: PEBBLE, status: 503, root, intermediate: root }))).toBeNull();
  });

  it("groups expect Let's Encrypt unless the run explicitly says test", () => {
    expect(runIsOnLetsEncrypt({})).toBe(true);
    expect(runIsOnLetsEncrypt({ GYM_ISSUANCE_CA: "letsencrypt" })).toBe(true);
    expect(runIsOnLetsEncrypt({ GYM_ISSUANCE_CA: "nonsense" })).toBe(true);
    expect(runIsOnLetsEncrypt({ GYM_ISSUANCE_CA: "test" })).toBe(false);
    expect(expectedIssuer({}).test("C = US, O = Let's Encrypt, CN = R11")).toBe(true);
    expect(expectedIssuer({}).test("CN = Pebble Intermediate CA 1a2b3c")).toBe(false);
    expect(expectedIssuer({ GYM_ISSUANCE_CA: "test" }).test("CN = Pebble Intermediate CA 1a2b3c")).toBe(true);
    expect(expectedIssuer({ GYM_ISSUANCE_CA: "test" }).test("C = US, O = Let's Encrypt, CN = R11")).toBe(false);
  });

  it("finds the test CA's roots next to its directory, over https only", () => {
    expect(testCaRootUrls(PEBBLE)).toEqual(["https://flagship-acme-gym.fly.dev/roots/0", "https://flagship-acme-gym.fly.dev/intermediates/0"]);
    expect(() => testCaRootUrls("http://pebble:14000/dir")).toThrow(/not https/);
  });
});

describe("the run's roots file", () => {
  it("keeps earlier roots and never repeats one", async () => {
    const a = await cert("Root A", true);
    const b = await cert("Root B", true);
    const once = mergeRootsFile("", [a]);
    expect(splitPems(once)).toHaveLength(1);
    const twice = mergeRootsFile(once, [a, b]);
    expect(splitPems(twice).map(pemFingerprint)).toEqual([pemFingerprint(a), pemFingerprint(b)]);
    expect(mergeRootsFile(twice, [b, a])).toBe(twice);
  });

  it("runs again with the roots file, once; a root that changes while starting stops the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-trust-"));
    const state = { directory: PEBBLE, root: await cert("Pebble Root CA", true), intermediate: await cert("Pebble Intermediate CA", true) };
    const first = await prepareAcmeTrust(CONTROL, dir, {}, fakeCa(state));
    expect(first.kind).toBe("test");
    if (first.kind !== "test") return;
    expect(first.reexec).toBe(true);
    expect(splitPems(readFileSync(first.rootsFile, "utf8"))).toHaveLength(2);
    const env = { NODE_EXTRA_CA_CERTS: first.rootsFile, [REEXEC_ENV]: "1" };
    const child = await prepareAcmeTrust(CONTROL, dir, env, fakeCa(state));
    expect(child).toMatchObject({ kind: "test", reexec: false, rootFingerprint: first.rootFingerprint });
    state.root = await cert("Pebble Root CA", true);
    await expect(prepareAcmeTrust(CONTROL, dir, env, fakeCa(state))).rejects.toThrow(/root changed/);
  });

  it("carries a reused fleet's roots into the new run", async () => {
    const old = mkdtempSync(join(tmpdir(), "acme-trust-old-"));
    const oldRoot = await cert("Pebble Root CA (old)", true);
    writeFileSync(join(old, "acme-roots.pem"), oldRoot);
    const dir = mkdtempSync(join(tmpdir(), "acme-trust-"));
    const state = { directory: PEBBLE, root: await cert("Pebble Root CA", true), intermediate: await cert("Pebble Intermediate CA", true) };
    const t = await prepareAcmeTrust(CONTROL, dir, {}, fakeCa(state), join(old, "acme-roots.pem"));
    if (t.kind !== "test") throw new Error(t.kind);
    expect(splitPems(readFileSync(t.rootsFile, "utf8")).map(pemFingerprint)).toContain(pemFingerprint(oldRoot));
  });

  it("does nothing on Let's Encrypt and without an issuance account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-trust-"));
    const root = await cert("x", true);
    expect((await prepareAcmeTrust(CONTROL, dir, {}, fakeCa({ directory: LETS_ENCRYPT_PRODUCTION, root, intermediate: root }))).kind).toBe("letsencrypt");
    expect((await prepareAcmeTrust(CONTROL, dir, {}, fakeCa({ directory: PEBBLE, status: 503, root, intermediate: root }))).kind).toBe("no-account");
  });

  it("refuses a leaf where a CA certificate should be", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-trust-"));
    const state = { directory: PEBBLE, root: await cert("evil.example", false), intermediate: await cert("Pebble Intermediate CA", true) };
    await expect(prepareAcmeTrust(CONTROL, dir, {}, fakeCa(state))).rejects.toThrow(/not a CA/);
  });

  it("notices a new root at the end of a run and adds it to the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-trust-"));
    const state = { directory: PEBBLE, root: await cert("Pebble Root CA", true), intermediate: await cert("Pebble Intermediate CA", true) };
    const t = await prepareAcmeTrust(CONTROL, dir, {}, fakeCa(state));
    if (t.kind !== "test") throw new Error(t.kind);
    expect((await testCaRootUnchanged(t, fakeCa(state))).same).toBe(true);
    state.root = await cert("Pebble Root CA", true);
    const r = await testCaRootUnchanged(t, fakeCa(state));
    expect(r.same).toBe(false);
    expect(splitPems(readFileSync(t.rootsFile, "utf8")).map(pemFingerprint)).toContain(r.now);
  });
});

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adapterFileCapabilityDigest,
  adapterIndexDigest,
  attestationDigest,
  buildAdapterFile,
  deriveRepoAdapter,
  ed,
  signAdapterAttestation,
  signAdapterIndex,
  type AdapterAttestation,
  type AdapterIndexBody,
  type AdapterIndexDocument,
  type Keypair,
} from "@flagship/protocol";
import { communityAdapters, httpAdapterIndex } from "../src/buildmodes/adapterIndex.js";
import {
  ADAPTER_VETTING_KEYS_PATH,
  hasCurrentVettingKey,
  loadAdapterVettingKeys,
  parseAdapterVettingKeys,
} from "../src/buildmodes/adapterVettingKeys.js";

const key = (b: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(b);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const VET = key(0x51);
const OTHER = key(0x52);
const T0 = 1_761_264_000_000;
const DAY = 86_400_000;
const PINNED = [{ pubHex: hex(VET.publicKey), notBefore: T0 - DAY, notAfter: T0 + 365 * DAY }];
const COM = "https://flagshipserver.com";
const REPO = "https://github.com/me/hello";
const COMMIT = "c".repeat(40);
const OLDER = "b".repeat(40);
const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "hello",
  version: "0.1.0",
  description: "Hello",
  runtime: { base: "node-24", port: 8080, start: ["node", "index.js"] },
});
const ORIGINAL = { "index.js": "const port = 3000;\n" };
const ADAPTED = { "index.js": "const port = process.env.PORT;\n" };
const fileFor = (base: string, manifest = MANIFEST) => buildAdapterFile(manifest, deriveRepoAdapter(ORIGINAL, ADAPTED, { repo: REPO, base }));
const CURRENT = fileFor(COMMIT);
const OLD = fileFor(OLDER);

function att(file: string, base: string, over: Partial<AdapterAttestation> = {}): AdapterAttestation {
  return {
    adapterDigestHex: sha(file),
    repo: REPO,
    baseRevision: base,
    capabilityDigestHex: adapterFileCapabilityDigest(file)!,
    validatorVersion: "adapter-rules/1",
    policyVersion: "adapter-review/1",
    reviewerModel: "claude-haiku-5-5",
    modelVersion: "claude-haiku-5-5",
    evidenceSha256Hex: "e".repeat(64),
    outcome: "pass",
    issuedAt: T0,
    expiresAt: T0 + 90 * DAY,
    ...over,
  };
}

function doc(seq: number, prev: string, atts: AdapterAttestation[], opts: { withdrawn?: string[]; signer?: Keypair; attSigner?: Keypair; issuedAt?: number } = {}) {
  const body: AdapterIndexBody = {
    sequence: seq,
    prevDigestHex: prev,
    issuedAt: opts.issuedAt ?? T0,
    expiresAt: (opts.issuedAt ?? T0) + 3 * DAY,
    attestationDigests: atts.map(attestationDigest),
    withdrawn: opts.withdrawn ?? [],
  };
  const d: AdapterIndexDocument = {
    schema: 1,
    index: signAdapterIndex(body, opts.signer ?? VET),
    attestations: atts.map((a) => signAdapterAttestation(a, opts.attSigner ?? VET)),
  };
  return { text: JSON.stringify(d), digest: adapterIndexDigest(body) };
}

function world(served: Record<string, string>) {
  const calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];
  const fetcher = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, ...(init.headers ? { headers: init.headers } : {}), ...(init.body ? { body: init.body } : {}) });
    const body = served[url];
    return { ok: body != null || init.method === "POST", text: async () => body ?? "" };
  };
  return { calls, fetcher };
}

const files = (...fs: string[]) => Object.fromEntries(fs.map((f) => [`${COM}/api/adapters/file/${sha(f)}`, f]));
let now = T0 + 1000;
const clock = () => now;

afterEach(() => {
  communityAdapters.lookupEnabled = false;
  now = T0 + 1000;
});

describe("community adapter lookup", () => {
  it("stays off, reading nothing, while no key is pinned", async () => {
    expect(loadAdapterVettingKeys()).toEqual([]);
    expect(communityAdapters.lookupEnabled).toBe(false);
    const { calls, fetcher } = world({ [`${COM}/api/adapters/index`]: doc(1, "genesis", [att(CURRENT, COMMIT)]).text, ...files(CURRENT) });
    const idx = httpAdapterIndex({ submitTo: `${COM}/`, highWaterPath: null, now: clock }, fetcher);
    expect(await idx.lookup(REPO, COMMIT)).toEqual([]);
    communityAdapters.lookupEnabled = true; // the switch alone is not enough: the release pins no key
    expect(await idx.lookup(REPO, COMMIT)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("offers only attested digests, this commit first, fetched by digest from .com, and sends nothing identifying", async () => {
    communityAdapters.lookupEnabled = true;
    const unattested = fileFor(COMMIT, JSON.stringify({ ...JSON.parse(MANIFEST), description: "Other" }));
    const { calls, fetcher } = world({
      [`${COM}/api/adapters/index`]: doc(1, "genesis", [att(OLD, OLDER), att(CURRENT, COMMIT)]).text,
      ...files(CURRENT, OLD, unattested),
    });
    const idx = httpAdapterIndex({ submitTo: `${COM}/`, pinned: () => PINNED, highWaterPath: null, now: clock }, fetcher);
    expect(await idx.lookup(REPO, COMMIT)).toEqual([
      { base: COMMIT, file: CURRENT, sha: sha(CURRENT) },
      { base: OLDER, file: OLD, sha: sha(OLD) },
    ]);
    expect(calls.some((c) => c.url.endsWith(sha(unattested)))).toBe(false);
    for (const c of calls) expect(c.headers).toBeUndefined();
    expect(await idx.lookup("https://github.com/me/unknown", COMMIT)).toEqual([]);
  });

  it("refuses a file that does not match its digest, or whose authority differs from what was attested", async () => {
    communityAdapters.lookupEnabled = true;
    const wider = fileFor(COMMIT, JSON.stringify({ ...JSON.parse(MANIFEST), network: { egress: ["evil.example"] } }));
    const lied = att(wider, COMMIT, { capabilityDigestHex: adapterFileCapabilityDigest(CURRENT)! });
    const { fetcher } = world({
      [`${COM}/api/adapters/index`]: doc(1, "genesis", [att(CURRENT, COMMIT), lied]).text,
      [`${COM}/api/adapters/file/${sha(CURRENT)}`]: CURRENT.replace("Hello", "Hullo"),
      [`${COM}/api/adapters/file/${sha(wider)}`]: wider,
    });
    const idx = httpAdapterIndex({ submitTo: COM, pinned: () => PINNED, highWaterPath: null, now: clock }, fetcher);
    expect(await idx.lookup(REPO, COMMIT)).toEqual([]);
  });

  it("ignores an index or attestation not signed by a pinned key, and a withdrawn or revoked digest", async () => {
    communityAdapters.lookupEnabled = true;
    const lookup = async (indexText: string) => {
      const { fetcher } = world({ [`${COM}/api/adapters/index`]: indexText, ...files(CURRENT) });
      return httpAdapterIndex({ submitTo: COM, pinned: () => PINNED, highWaterPath: null, now: clock }, fetcher).lookup(REPO, COMMIT);
    };
    expect(await lookup(doc(1, "genesis", [att(CURRENT, COMMIT)], { signer: OTHER }).text)).toEqual([]);
    expect(await lookup(doc(1, "genesis", [att(CURRENT, COMMIT)], { attSigner: OTHER }).text)).toEqual([]);
    expect(await lookup(doc(1, "genesis", [att(CURRENT, COMMIT)], { withdrawn: [sha(CURRENT)] }).text)).toEqual([]);
    const revoked = att(CURRENT, COMMIT, { outcome: "revoked", issuedAt: T0 + 1, expiresAt: T0 + 93 * DAY });
    expect(await lookup(doc(1, "genesis", [att(CURRENT, COMMIT), revoked]).text)).toEqual([]);
    expect(await lookup(doc(1, "genesis", [att(CURRENT, COMMIT, { expiresAt: T0 + 500 })]).text)).toEqual([]);
    expect(await lookup("not json")).toEqual([]);
    expect(await lookup(JSON.stringify({ schema: 2 }))).toEqual([]);
  });

  it("remembers the highest index across restarts, so a replayed older one cannot undo a revocation", async () => {
    communityAdapters.lookupEnabled = true;
    const dir = mkdtempSync(join(tmpdir(), "adapter-hw-"));
    const highWaterPath = join(dir, "hw.json");
    const one = doc(1, "genesis", [att(CURRENT, COMMIT)]);
    const revoked = att(CURRENT, COMMIT, { outcome: "revoked", issuedAt: T0 + DAY, expiresAt: T0 + 93 * DAY });
    const two = doc(2, one.digest, [revoked], { withdrawn: [sha(CURRENT)], issuedAt: T0 + DAY });
    const served: Record<string, string> = { [`${COM}/api/adapters/index`]: two.text, ...files(CURRENT) };
    const { fetcher } = world(served);
    now = T0 + DAY + 1000;
    const first = httpAdapterIndex({ submitTo: COM, pinned: () => PINNED, highWaterPath, now: clock }, fetcher);
    expect(await first.lookup(REPO, COMMIT)).toEqual([]);
    expect(JSON.parse(readFileSync(highWaterPath, "utf8"))).toEqual({ sequence: 2, digestHex: two.digest });
    served[`${COM}/api/adapters/index`] = one.text;
    const restarted = httpAdapterIndex({ submitTo: COM, pinned: () => PINNED, highWaterPath, now: clock }, fetcher);
    expect(await restarted.lookup(REPO, COMMIT)).toEqual([]);
    const amnesiac = httpAdapterIndex({ submitTo: COM, pinned: () => PINNED, highWaterPath: null, now: clock }, fetcher);
    expect(await amnesiac.lookup(REPO, COMMIT)).toHaveLength(1); // what the remembered mark prevents
  });

  it("a corrupt high-water file is set aside and checking starts over", async () => {
    communityAdapters.lookupEnabled = true;
    const dir = mkdtempSync(join(tmpdir(), "adapter-hw-"));
    const highWaterPath = join(dir, "hw.json");
    writeFileSync(highWaterPath, "{torn");
    const { fetcher } = world({ [`${COM}/api/adapters/index`]: doc(1, "genesis", [att(CURRENT, COMMIT)]).text, ...files(CURRENT) });
    const idx = httpAdapterIndex({ submitTo: COM, pinned: () => PINNED, highWaterPath, now: clock }, fetcher);
    expect(await idx.lookup(REPO, COMMIT)).toHaveLength(1);
    expect(JSON.parse(readFileSync(highWaterPath, "utf8"))).toMatchObject({ sequence: 1 });
  });

  it("an offline .com means no candidates, and submit still sends only the adapter", async () => {
    communityAdapters.lookupEnabled = true;
    const offline = httpAdapterIndex({ submitTo: COM, pinned: () => PINNED, highWaterPath: null }, async () => {
      throw new Error("offline");
    });
    expect(await offline.lookup(REPO, COMMIT)).toEqual([]);
    const { calls, fetcher } = world({});
    await httpAdapterIndex({ submitTo: `${COM}/`, pinned: () => PINNED, highWaterPath: null }, fetcher).submit({ repo: REPO, base: COMMIT, licensePath: "LICENSE", file: "{}" });
    expect(calls).toEqual([
      {
        url: `${COM}/api/adapters/submit`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: REPO, base: COMMIT, licensePath: "LICENSE", file: "{}", wait: true }),
      },
    ]);
  });
});

describe("pinned adapter-vetting keys", () => {
  it("the box reads release/adapter-vetting-keys.json from its own tree, and it is well formed", () => {
    expect(ADAPTER_VETTING_KEYS_PATH.endsWith(join("release", "adapter-vetting-keys.json"))).toBe(true);
    const text = readFileSync(ADAPTER_VETTING_KEYS_PATH, "utf8");
    expect(parseAdapterVettingKeys(text)).not.toBeNull();
    expect(loadAdapterVettingKeys()).toEqual(parseAdapterVettingKeys(text));
  });

  it("parses a pinned key with its window, and refuses anything malformed", () => {
    const pub = hex(VET.publicKey);
    const ok = parseAdapterVettingKeys(JSON.stringify({ schema: 1, keys: [{ pubHex: pub, notBefore: "2026-10-24T00:00:00Z", notAfter: "2027-10-24T00:00:00Z" }] }));
    expect(ok).toEqual([{ pubHex: pub, notBefore: Date.parse("2026-10-24T00:00:00Z"), notAfter: Date.parse("2027-10-24T00:00:00Z") }]);
    expect(hasCurrentVettingKey(ok!, Date.parse("2027-01-01T00:00:00Z"))).toBe(true);
    expect(hasCurrentVettingKey(ok!, Date.parse("2028-01-01T00:00:00Z"))).toBe(false);
    for (const bad of [
      "nope",
      JSON.stringify({ schema: 2, keys: [] }),
      JSON.stringify({ schema: 1, keys: [{ pubHex: "AB", notBefore: "2026-10-24", notAfter: "2027-10-24" }] }),
      JSON.stringify({ schema: 1, keys: [{ pubHex: pub, notBefore: "2027-10-24", notAfter: "2026-10-24" }] }),
      JSON.stringify({ schema: 1, keys: [{ pubHex: pub, notBefore: 1, notAfter: 2 }] }),
    ]) {
      expect(parseAdapterVettingKeys(bad), bad).toBeNull();
    }
    const dir = mkdtempSync(join(tmpdir(), "adapter-keys-"));
    expect(loadAdapterVettingKeys(join(dir, "missing.json"))).toEqual([]);
  });
});

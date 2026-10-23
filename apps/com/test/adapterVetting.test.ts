/**
 * The adapter vetting pipeline and its signed index (src/adapterVetting.ts) over a real
 * D1-over-sqlite binding with every migration applied, an in-memory R2 bucket, and a mocked fetch
 * standing in for the git hosts' raw URLs and the Anthropic API. What `.com` signs is checked with
 * the same protocol verifiers a box uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adapterFileCapabilityDigest,
  buildAdapterFile,
  deriveRepoAdapter,
  ed,
  verifyAdapterAttestation,
  verifyAdapterIndex,
  type AdapterIndexDocument,
} from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { handleAdapterIndex, type AdapterBucketLike, type AdapterIndexEnv } from "../src/adapterIndex.js";
import {
  INDEX_TTL_MS,
  RETIRE_AT_SOURCES,
  publishAdapterIndex,
  runAdapterVetting,
  sourceNetwork,
} from "../src/adapterVetting.js";
import { REVIEW_MODEL, REVIEW_POLICY_VERSION } from "../src/adapterReview.js";

const ORIGIN = "https://flagshipserver.com";
const REPO = "https://github.com/me/notes";
const BASE = "a".repeat(40);
const RAW = `https://raw.githubusercontent.com/me/notes/${BASE}/`;
const ADMIN = "admin-secret";
const SEED = "5a".repeat(32);
const VET_PUB = Buffer.from(ed.getPublicKey(Uint8Array.from(Buffer.from(SEED, "hex")))).toString("hex");
const PINNED = [{ pubHex: VET_PUB, notBefore: 0, notAfter: 4_000_000_000_000 }];

const MIT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
`;
const MANIFEST = JSON.stringify({ schema_version: 1, name: "notes", version: "0.1.0", description: "Notes", runtime: { image: "x", port: 8080 } });
const ORIGINAL: Record<string, string> = { "index.js": "const a = 1;\nconst port = 3000;\napp.listen(port);\n" };
const ADAPTED: Record<string, string> = { "index.js": "const a = 1;\nconst port = process.env.PORT;\napp.listen(port);\n" };
const adapterFile = (over: { adapted?: Record<string, string>; manifest?: string } = {}) =>
  buildAdapterFile(over.manifest ?? MANIFEST, deriveRepoAdapter(ORIGINAL, over.adapted ?? ADAPTED, { repo: REPO, base: BASE }));

class MemoryBucket implements AdapterBucketLike {
  objects = new Map<string, string>();
  async get(key: string) {
    const v = this.objects.get(key);
    return v == null ? null : { text: async () => v };
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

let raw: Map<string, string>;
let reviews: string[];
let anthropic: () => Response;
const realFetch = globalThis.fetch;
const verdict = (ok: boolean, category = ok ? "none" : "sends data out of the server") =>
  new Response(
    JSON.stringify({ model: "claude-haiku-5-5-20261001", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ok, category }) }] }),
    { status: 200 },
  );

beforeEach(() => {
  raw = new Map([[`${RAW}LICENSE`, MIT], ...Object.entries(ORIGINAL).map(([p, c]) => [`${RAW}${p}`, c] as [string, string])]);
  reviews = [];
  anthropic = () => verdict(true);
  globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://api.anthropic.com/v1/messages") {
      reviews.push(JSON.parse(init!.body as string).messages[0].content as string);
      return anthropic();
    }
    const body = raw.get(url);
    return body == null ? new Response("404", { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Fx {
  env: AdapterIndexEnv;
  db: D1Database;
  bucket: MemoryBucket;
  pending: Promise<unknown>[];
  close(): void;
}
let fx: Fx;
function makeFx(over: Partial<AdapterIndexEnv> = {}): Fx {
  const sqlite = createSqliteD1();
  const bucket = new MemoryBucket();
  const db = sqlite as unknown as D1Database;
  return {
    env: {
      DB: db,
      ADAPTERS_BUCKET: bucket,
      FLAGSHIP_ADMIN_SECRET: ADMIN,
      ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test",
      ADAPTER_ATTESTATION_SIGNING_KEY: SEED,
      ADAPTER_COMPLAINT_SALT: "salt",
      ...over,
    },
    db,
    bucket,
    pending: [],
    close: () => sqlite.close(),
  };
}
beforeEach(() => {
  fx = makeFx();
});
afterEach(() => fx.close());

const call = (req: Request, f = fx) => handleAdapterIndex(req, f.env, { waitUntil: (p) => f.pending.push(p) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
async function ask(file = adapterFile(), f = fx) {
  const res = await call(post("/api/adapters/submit", { repo: REPO, base: BASE, licensePath: "LICENSE", file, wait: true }), f);
  return (await res.json()) as { status: string; file: string; reasons?: Array<{ code: string }> };
}
async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(new Uint8Array(d)).toString("hex");
}
async function index(f = fx): Promise<{ status: number; doc?: AdapterIndexDocument }> {
  const res = await call(new Request(`${ORIGIN}/api/adapters/index`), f);
  return res.status === 200 ? { status: 200, doc: (await res.json()) as AdapterIndexDocument } : { status: res.status };
}
const fileStatus = async (sha: string, f = fx) => (await call(new Request(`${ORIGIN}/api/adapters/file/${sha}`), f)).status;
const attestations = async (f = fx) =>
  (await f.db.prepare("SELECT adapter_sha256, outcome, reason FROM adapter_attestations ORDER BY issued_at").bind().all<Record<string, unknown>>()).results;

describe("vetting a submission", () => {
  it("attests a file that passes every check and the review, and boxes can verify what is served", async () => {
    const file = adapterFile();
    const sha = await sha256(file);
    expect(await ask(file)).toEqual({ status: "kept", file: sha });
    const { status, doc } = await index();
    expect(status).toBe(200);
    const now = Date.now();
    const v = verifyAdapterIndex(doc!.index, PINNED, null, now);
    expect(v).toMatchObject({ ok: true });
    expect(doc!.index.index.sequence).toBe(1);
    expect(doc!.attestations).toHaveLength(1);
    const a = doc!.attestations[0]!;
    expect(verifyAdapterAttestation(a, PINNED)).toBe(true);
    expect(a.attestation).toMatchObject({
      adapterDigestHex: sha,
      repo: REPO,
      baseRevision: BASE,
      capabilityDigestHex: adapterFileCapabilityDigest(file),
      validatorVersion: "adapter-rules/1",
      policyVersion: REVIEW_POLICY_VERSION,
      reviewerModel: REVIEW_MODEL,
      modelVersion: "claude-haiku-5-5-20261001",
      outcome: "pass",
    });
    expect(a.attestation.expiresAt).toBeGreaterThan(a.attestation.issuedAt);
    const served = await call(new Request(`${ORIGIN}/api/adapters/file/${sha}`));
    expect(served.status).toBe(200);
    expect(await sha256(await served.text())).toBe(sha);
    const evidence = await fx.db.prepare("SELECT evidence_json FROM adapter_attestations").bind().first<{ evidence_json: string }>();
    expect(await sha256(evidence!.evidence_json)).toBe(a.attestation.evidenceSha256Hex);
  });

  it("shows the model the adapter file and nothing else", async () => {
    const file = adapterFile();
    await ask(file);
    expect(reviews).toEqual([`<adaptation>\n${file}\n</adaptation>`]);
  });

  it("a failing deterministic check never reaches the model", async () => {
    const broken = adapterFile({ manifest: JSON.stringify({ ...JSON.parse(MANIFEST), version: "x" }) });
    expect((await ask(broken)).status).toBe("refused");
    raw.delete(`${RAW}LICENSE`);
    expect((await ask()).reasons?.map((r) => r.code)).toEqual(["no-license"]);
    expect(reviews).toEqual([]);
    expect(await attestations()).toEqual([]);
    expect((await index()).status).toBe(404);
  });

  it("a failed or unavailable review attests nothing", async () => {
    anthropic = () => verdict(false);
    expect((await ask()).reasons?.map((r) => r.code)).toEqual(["review"]);
    anthropic = () => new Response("overloaded", { status: 529 });
    expect((await ask()).reasons?.map((r) => r.code)).toEqual(["review-unavailable"]);
    expect(await attestations()).toEqual([]);
    expect(await fileStatus(await sha256(adapterFile()))).toBe(404);
  });

  it("neither key alone vets anything", async () => {
    for (const over of [{ ADAPTER_ATTESTATION_SIGNING_KEY: undefined }, { ADAPTER_REVIEW_ANTHROPIC_KEY: undefined }]) {
      const f = makeFx(over);
      try {
        expect((await ask(adapterFile(), f)).status).toBe("kept");
        expect(await attestations(f)).toEqual([]);
        expect((await index(f)).status).toBe(404);
      } finally {
        f.close();
      }
    }
  });

  it("a file the model saw only part of is kept but not attested", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i} of a long generated file`).join("\n");
    expect((await ask(adapterFile({ adapted: { ...ADAPTED, "big.txt": big } }))).status).toBe("kept");
    expect(await attestations()).toEqual([]);
  });
});

describe("the signed index", () => {
  it("is append-only: each version extends the last, and an unchanged one is only re-signed a day later", async () => {
    await ask();
    const first = (await index()).doc!;
    const t = first.index.index.issuedAt;
    expect(await publishAdapterIndex(fx.env, t + 1000)).toEqual({ published: false, sequence: 1 });
    expect(await publishAdapterIndex(fx.env, t + 86_400_000)).toEqual({ published: true, sequence: 2 });
    const second = (await index()).doc!;
    const hw = verifyAdapterIndex(first.index, PINNED, null, t + 1000);
    if (!hw.ok) throw new Error(hw.reason);
    expect(verifyAdapterIndex(second.index, PINNED, { sequence: 1, digestHex: hw.digestHex }, t + 86_400_000 + 1)).toMatchObject({ ok: true });
    expect(second.index.index.expiresAt - second.index.index.issuedAt).toBe(INDEX_TTL_MS);
  });

  it("nothing is served before the first index, and the endpoints are GET only", async () => {
    expect((await index()).status).toBe(404);
    expect(await fileStatus("z")).toBe(404);
    expect((await call(post("/api/adapters/index", {}))).status).toBe(405);
  });
});

describe("withdrawal", () => {
  async function attested(): Promise<string> {
    const file = adapterFile();
    await ask(file);
    return sha256(file);
  }
  async function complainFrom(ip: string, file: string) {
    const res = await call(post("/api/adapters/complain", { repo: REPO, file, stage: "build" }, { "cf-connecting-ip": ip }));
    expect(res.status).toBe(202);
    await Promise.all(fx.pending.splice(0));
  }

  it("one network complaining again and again, from many addresses, withdraws nothing", async () => {
    const sha = await attested();
    for (let i = 1; i <= 6; i++) await complainFrom(`203.0.113.${i}`, sha);
    for (let i = 1; i <= 6; i++) await complainFrom(`2001:db8:7:${i}::1`, sha);
    expect(await attestations()).toEqual([{ adapter_sha256: sha, outcome: "pass", reason: null }]);
    const sources = await fx.db.prepare("SELECT count(*) AS n FROM adapter_complaint_sources").bind().first<{ n: number }>();
    expect(sources!.n).toBe(2);
    const stored = await fx.db.prepare("SELECT source FROM adapter_complaint_sources").bind().all<{ source: string }>();
    for (const r of stored.results) expect(r.source).toMatch(/^[0-9a-f]{32}$/);
  });

  it(`complaints from ${RETIRE_AT_SOURCES} distinct networks revoke it, signed, and the index carries it`, async () => {
    const sha = await attested();
    await complainFrom("203.0.113.1", sha);
    await complainFrom("198.51.100.1", sha);
    expect(await fileStatus(sha)).toBe(200);
    await complainFrom("192.0.2.1", sha);
    expect(await attestations()).toEqual([
      { adapter_sha256: sha, outcome: "pass", reason: null },
      { adapter_sha256: sha, outcome: "revoked", reason: "reports" },
    ]);
    const { doc } = await index();
    expect(doc!.index.index.sequence).toBe(2);
    expect(doc!.index.index.withdrawn).toEqual([sha]);
    expect(doc!.attestations.map((a) => a.attestation.outcome)).toEqual(["revoked"]);
    expect(verifyAdapterAttestation(doc!.attestations[0]!, PINNED)).toBe(true);
    expect(await fileStatus(sha)).toBe(404);
    expect((await ask()).reasons?.map((r) => r.code)).toEqual(["retired"]);
    // Kept as evidence.
    expect(fx.bucket.objects.has(`attested/${sha}.json`)).toBe(true);
  });

  it("without the salt complaints are kept but count toward nothing", async () => {
    const f = makeFx({ ADAPTER_COMPLAINT_SALT: undefined });
    try {
      const file = adapterFile();
      await ask(file, f);
      const sha = await sha256(file);
      for (const ip of ["203.0.113.1", "198.51.100.1", "192.0.2.1"]) {
        await call(post("/api/adapters/complain", { repo: REPO, file: sha, stage: "build" }, { "cf-connecting-ip": ip }), f);
      }
      await Promise.all(f.pending.splice(0));
      expect((await attestations(f)).map((a) => a.outcome)).toEqual(["pass"]);
      const kept = await f.db.prepare("SELECT count(*) AS n FROM adapter_complaints").bind().first<{ n: number }>();
      expect(kept!.n).toBe(3);
    } finally {
      f.close();
    }
  });

  it("the repo owner's opt-out revokes what was attested at once", async () => {
    const sha = await attested();
    const res = await call(post("/api/admin/adapter-blocklist", { repo: REPO }, { "x-admin-secret": ADMIN }));
    expect(await res.json()).toMatchObject({ blocked: true, revoked: 1 });
    expect((await index()).doc!.index.index.withdrawn).toEqual([sha]);
  });
});

describe("the daily vetting run", () => {
  it("vets what was kept before there was a key, checks first, then signs the index", async () => {
    const noKey = makeFx({ ADAPTER_REVIEW_ANTHROPIC_KEY: undefined });
    try {
      const file = adapterFile();
      await ask(file, noKey);
      const broken = adapterFile({ manifest: JSON.stringify({ ...JSON.parse(MANIFEST), version: "x" }) });
      const brokenSha = await sha256(broken);
      await noKey.bucket.put(`pending/${brokenSha}.json`, broken);
      await noKey.db
        .prepare(
          `INSERT INTO repo_adapters (file_sha256, repo, base, license, review, bytes, r2_key, confirmations, pending_confirmations, created_day)
           VALUES (?, ?, ?, 'MIT', 'rules', 1, ?, 0, 1, '2026-01-01')`,
        )
        .bind(brokenSha, REPO, BASE, `pending/${brokenSha}.json`)
        .run();
      expect(reviews).toEqual([]);
      const r = await runAdapterVetting({ ...noKey.env, ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" }, new Date());
      expect(r).toMatchObject({ vetted: 1, failed: 1, index: { published: true, sequence: 1 } });
      expect(reviews).toEqual([`<adaptation>\n${file}\n</adaptation>`]);
      expect((await attestations(noKey)).map((a) => a.adapter_sha256)).toEqual([await sha256(file)]);
    } finally {
      noKey.close();
    }
  });

  it("a later failed review revokes a pass; nothing runs without the attestation key", async () => {
    const sha = (await ask()).file;
    expect(await runAdapterVetting({ ...fx.env, ADAPTER_ATTESTATION_SIGNING_KEY: undefined }, new Date())).toBeNull();
    // Due for renewal: the pass ends inside the renewal window.
    await fx.db.prepare("UPDATE adapter_attestations SET expires_at = ?").bind(Date.now() + 86_400_000).run();
    anthropic = () => verdict(false);
    const r = await runAdapterVetting(fx.env, new Date());
    expect(r).toMatchObject({ revoked: 1 });
    expect((await attestations()).map((a) => [a.outcome, a.reason])).toEqual([["pass", null], ["revoked", "review"]]);
    expect((await index()).doc!.index.index.withdrawn).toEqual([sha]);
  });
});

describe("sourceNetwork", () => {
  it("groups IPv4 by /24 and IPv6 by /48", () => {
    expect(sourceNetwork("203.0.113.9")).toBe("203.0.113.0/24");
    expect(sourceNetwork("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
    expect(sourceNetwork("2001:db8:7:1::1")).toBe("2001:db8:7::/48");
    expect(sourceNetwork("2001:0DB8:0007:ffff:1:2:3:4")).toBe("2001:db8:7::/48");
    expect(sourceNetwork("::1")).toBe("0:0:0::/48");
    for (const bad of [null, "", "300.1.1.1", "nope", "1:2:3", "1::2::3"]) expect(sourceNetwork(bad), String(bad)).toBeNull();
  });
});

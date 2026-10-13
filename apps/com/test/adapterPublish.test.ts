/**
 * The daily publish of the repo adapter queue (src/adapterPublish.ts) to the
 * public index repo, against an in-memory fake of GitHub's Git Data API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { handleAdapterIndex, type AdapterBucketLike } from "../src/adapterIndex.js";
import { MAX_NEW_PER_PUBLISH, README, repoDir, runAdapterPublish, type AdapterPublishEnv } from "../src/adapterPublish.js";
import { scheduled } from "../src/scheduled.js";
import { runAdapterInsights } from "../src/adapterInsights.js";

const REPO_NAME = "ibisllc/flagship-adapters";
const API = `https://api.github.com/repos/${REPO_NAME}`;
const NOW = new Date(Date.UTC(2026, 9, 12, 0, 0, 7, 123));
const DAY = "2026-10-12";
const ADMIN = "admin-secret";

// ---- fake GitHub -----------------------------------------------------------

interface Commit {
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}

class FakeGitHub {
  blobs = new Map<string, string>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, Commit>();
  head: string;
  calls: Array<{ method: string; path: string; auth: string | null; ua: string | null }> = [];
  failRefUpdate = false;
  private n = 0;

  constructor(initial: Record<string, string>) {
    const tree = this.addTree(new Map(Object.entries(initial)));
    this.head = this.id("c");
    this.commits.set(this.head, {
      tree,
      parents: [],
      message: "Initial commit",
      author: { name: "owner", email: "o@x", date: "2026-10-11T09:00:00Z" },
      committer: { name: "owner", email: "o@x", date: "2026-10-11T09:00:00Z" },
    });
  }

  private id(kind: string): string {
    return `${kind}${(++this.n).toString().padStart(39, "0")}`;
  }

  private addTree(files: Map<string, string>): string {
    // Content-addressed like git: identical file sets share a tree id.
    const key = JSON.stringify([...files].sort());
    for (const [id, t] of this.trees) if (JSON.stringify([...t].sort()) === key) return id;
    const id = this.id("t");
    this.trees.set(id, files);
    return id;
  }

  files(): Record<string, string> {
    return Object.fromEntries(this.trees.get(this.commits.get(this.head)!.tree)!);
  }

  headCommit(): Commit {
    return this.commits.get(this.head)!;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(`/repos/${REPO_NAME}`, "");
    this.calls.push({ method: req.method, path, auth: req.headers.get("authorization"), ua: req.headers.get("user-agent") });
    const body = req.method === "GET" ? null : ((await req.json()) as Record<string, any>);
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (req.method === "GET" && path === "/git/ref/heads/main") return ok({ object: { sha: this.head } });
    if (req.method === "GET" && path.startsWith("/git/commits/")) {
      const c = this.commits.get(path.slice("/git/commits/".length));
      return c ? ok({ tree: { sha: c.tree } }) : ok({}, 404);
    }
    if (req.method === "GET" && path === "/contents/README.md") {
      const ref = url.searchParams.get("ref")!;
      const files = this.trees.get(this.commits.get(ref)!.tree)!;
      return files.has("README.md") ? ok({ name: "README.md" }) : ok({ message: "Not Found" }, 404);
    }
    if (req.method === "POST" && path === "/git/blobs") {
      expect(body!.encoding).toBe("utf-8");
      const id = this.id("b");
      this.blobs.set(id, body!.content);
      return ok({ sha: id }, 201);
    }
    if (req.method === "POST" && path === "/git/trees") {
      const files = new Map(this.trees.get(body!.base_tree)!);
      for (const e of body!.tree as Array<{ path: string; sha?: string | null; content?: string }>) {
        if (e.sha === null) {
          if (!files.has(e.path)) return ok({ message: `path ${e.path} not in tree` }, 422);
          files.delete(e.path);
        } else if (typeof e.content === "string") files.set(e.path, e.content);
        else files.set(e.path, this.blobs.get(e.sha!)!);
      }
      return ok({ sha: this.addTree(files) }, 201);
    }
    if (req.method === "POST" && path === "/git/commits") {
      const id = this.id("c");
      this.commits.set(id, body as Commit);
      return ok({ sha: id }, 201);
    }
    if (req.method === "PATCH" && path === "/git/refs/heads/main") {
      const c = this.commits.get(body!.sha)!;
      if (this.failRefUpdate || body!.force !== false || c.parents[0] !== this.head) {
        return ok({ message: "Update is not a fast forward" }, 422);
      }
      this.head = body!.sha;
      return ok({ object: { sha: this.head } });
    }
    return ok({ message: "unexpected" }, 500);
  }
}

// ---- fixtures --------------------------------------------------------------

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

let gh: FakeGitHub;
let sqlite: ReturnType<typeof createSqliteD1>;
let db: D1Database;
let bucket: MemoryBucket;
let env: AdapterPublishEnv;
const realFetch = globalThis.fetch;

beforeEach(() => {
  gh = new FakeGitHub({ "README.md": "# flagship-adapters\n" });
  sqlite = createSqliteD1();
  db = sqlite as unknown as D1Database;
  bucket = new MemoryBucket();
  env = { DB: db, ADAPTERS_BUCKET: bucket, ADAPTERS_GITHUB_TOKEN: "ghp-test", ADAPTERS_REPO: REPO_NAME };
  globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input.toString(), init);
    if (req.url.startsWith(API)) return gh.handle(req);
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  sqlite.close();
});

const sha = (n: number) => n.toString(16).padStart(64, "0");
const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);

async function queue(o: { repo: string; n: number; base?: string; pending?: number; license?: string; day?: string }) {
  const key = `pending/${sha(o.n)}.json`;
  bucket.objects.set(key, `{"file":${o.n}}\n`);
  await db
    .prepare(
      `INSERT INTO repo_adapters (file_sha256, repo, base, license, review, bytes, r2_key, confirmations, pending_confirmations, created_day)
       VALUES (?, ?, ?, ?, 'rules', 10, ?, 0, ?, ?)`,
    )
    .bind(sha(o.n), o.repo, o.base ?? BASE_A, o.license ?? "MIT", key, o.pending ?? 1, o.day ?? "2026-10-11")
    .run();
}

async function all(sql: string) {
  return (await db.prepare(sql).bind().all<Record<string, unknown>>()).results;
}

function block(repo: string, method = "POST") {
  return handleAdapterIndex(
    new Request("https://flagshipserver.com/api/admin/adapter-blocklist", {
      method,
      headers: { "x-admin-secret": ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ repo }),
    }),
    { DB: db, ADAPTERS_BUCKET: bucket, FLAGSHIP_ADMIN_SECRET: ADMIN },
  );
}

const NOTES = "https://github.com/me/notes";
const GROUP = "https://gitlab.com/group/sub/app";

// ---- tests -----------------------------------------------------------------

describe("runAdapterPublish", () => {
  it("does nothing, and keeps the queue, without the token or the repo name", async () => {
    await queue({ repo: NOTES, n: 1 });
    for (const e of [{ ...env, ADAPTERS_GITHUB_TOKEN: undefined }, { ...env, ADAPTERS_REPO: undefined }]) {
      expect(await runAdapterPublish(e, NOW)).toEqual({ published: false, reason: "not configured" });
    }
    expect(gh.calls).toHaveLength(0);
    expect(await all("SELECT published_day FROM repo_adapters")).toEqual([{ published_day: null }]);
    expect(bucket.objects.size).toBe(1);
  });

  it("does nothing when nothing is queued", async () => {
    expect(await runAdapterPublish(env, NOW)).toEqual({ published: false, reason: "nothing to publish" });
    expect(gh.calls).toHaveLength(0);
  });

  it("publishes every queued adapter in one commit dated to the UTC day", async () => {
    await queue({ repo: NOTES, n: 1, pending: 2 });
    await queue({ repo: NOTES, n: 2, base: BASE_B });
    await queue({ repo: GROUP, n: 3, license: "AGPL-3.0" });
    const before = gh.head;
    const r = await runAdapterPublish(env, NOW);
    expect(r).toMatchObject({ published: true, added: 3, confirmed: 0 });

    const c = gh.headCommit();
    expect(c.parents).toEqual([before]);
    expect(gh.calls.filter((x) => x.path === "/git/commits" && x.method === "POST")).toHaveLength(1);
    expect(c.message).toBe(`Adapters for ${DAY} (3 new, 0 confirmed)`);
    const stamp = { name: "Flagship adapters", email: "adapters@flagshipserver.com", date: `${DAY}T00:00:00Z` };
    expect(c.author).toEqual(stamp);
    expect(c.committer).toEqual(stamp);
    for (const call of gh.calls) {
      expect(call.auth).toBe("Bearer ghp-test");
      expect(call.ua).toBeTruthy();
    }

    const files = gh.files();
    expect(files[`adapters/github.com/me/notes/${sha(1)}.json`]).toBe('{"file":1}\n');
    expect(files[`adapters/gitlab.com/group/sub/app/${sha(3)}.json`]).toBe('{"file":3}\n');
    expect(JSON.parse(files["adapters/github.com/me/notes/index.json"]!)).toEqual({
      repo: NOTES,
      license: "MIT",
      adapters: [
        { base: BASE_A, file: `${sha(1)}.json`, added: DAY, confirmations: 2, complaints: 0 },
        { base: BASE_B, file: `${sha(2)}.json`, added: DAY, confirmations: 1, complaints: 0 },
      ],
    });
    expect(JSON.parse(files["adapters/gitlab.com/group/sub/app/index.json"]!).license).toBe("AGPL-3.0");
    expect(files["do-not-adapt.txt"]).toBe("");
    // The owner's README stays.
    expect(files["README.md"]).toBe("# flagship-adapters\n");

    expect(await all("SELECT file_sha256, published_day, confirmations, pending_confirmations, r2_key FROM repo_adapters ORDER BY file_sha256")).toEqual([
      { file_sha256: sha(1), published_day: DAY, confirmations: 2, pending_confirmations: 0, r2_key: null },
      { file_sha256: sha(2), published_day: DAY, confirmations: 1, pending_confirmations: 0, r2_key: null },
      { file_sha256: sha(3), published_day: DAY, confirmations: 1, pending_confirmations: 0, r2_key: null },
    ]);
    expect(bucket.objects.size).toBe(0);
  });

  it("writes the README when the repo has none", async () => {
    gh = new FakeGitHub({ ".gitkeep": "" });
    await queue({ repo: NOTES, n: 1 });
    await runAdapterPublish(env, NOW);
    expect(gh.files()["README.md"]).toBe(README);
    expect(README).toContain("flagshipserver.com/adapters");
    expect(README).toContain("do-not-adapt.txt");
  });

  it("bumps confirmations in index.json, newest entries first", async () => {
    await queue({ repo: NOTES, n: 1 });
    await runAdapterPublish(env, NOW);
    await db.prepare("UPDATE repo_adapters SET pending_confirmations = 4").bind().run();
    await queue({ repo: NOTES, n: 2, base: BASE_B });
    const later = new Date(Date.UTC(2026, 9, 13, 0, 0, 0));
    expect(await runAdapterPublish(env, later)).toMatchObject({ published: true, added: 1, confirmed: 1 });
    expect(gh.headCommit().message).toBe("Adapters for 2026-10-13 (1 new, 1 confirmed)");
    expect(JSON.parse(gh.files()["adapters/github.com/me/notes/index.json"]!).adapters).toEqual([
      { base: BASE_B, file: `${sha(2)}.json`, added: "2026-10-13", confirmations: 1, complaints: 0 },
      { base: BASE_A, file: `${sha(1)}.json`, added: DAY, confirmations: 5, complaints: 0 },
    ]);
    expect(await all(`SELECT confirmations, pending_confirmations FROM repo_adapters WHERE file_sha256 = '${sha(1)}'`)).toEqual([
      { confirmations: 5, pending_confirmations: 0 },
    ]);
  });

  it("keeps confirmations that arrive while it publishes", async () => {
    await queue({ repo: NOTES, n: 1 });
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const res = await inner(input, init);
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/git/trees")) {
        await db.prepare("UPDATE repo_adapters SET pending_confirmations = pending_confirmations + 1").bind().run();
      }
      return res;
    }) as typeof globalThis.fetch;
    await runAdapterPublish(env, NOW);
    expect(await all("SELECT confirmations, pending_confirmations FROM repo_adapters")).toEqual([
      { confirmations: 1, pending_confirmations: 1 },
    ]);
  });

  it("leaves the queue intact when the ref update fails", async () => {
    await queue({ repo: NOTES, n: 1 });
    gh.failRefUpdate = true;
    await expect(runAdapterPublish(env, NOW)).rejects.toThrow(/refs\/heads\/main: 422/);
    expect(await all("SELECT published_day, pending_confirmations FROM repo_adapters")).toEqual([
      { published_day: null, pending_confirmations: 1 },
    ]);
    expect(bucket.objects.size).toBe(1);
    gh.failRefUpdate = false;
    expect(await runAdapterPublish(env, NOW)).toMatchObject({ published: true, added: 1 });
  });

  it("caps one publish and leaves the rest for the next day", async () => {
    for (let i = 1; i <= MAX_NEW_PER_PUBLISH + 2; i++) await queue({ repo: NOTES, n: i });
    expect(await runAdapterPublish(env, NOW)).toMatchObject({ added: MAX_NEW_PER_PUBLISH });
    expect(await all("SELECT count(*) AS n FROM repo_adapters WHERE published_day IS NULL")).toEqual([{ n: 2 }]);
  });

  it("listing a repo removes its directory and appends it to do-not-adapt.txt; unlisting drops the line", async () => {
    await queue({ repo: NOTES, n: 1 });
    await queue({ repo: GROUP, n: 2 });
    await runAdapterPublish(env, NOW);
    expect((await block("https://github.com/Me/Notes")).status).toBe(200);
    expect((await block("https://codeberg.org/x/y")).status).toBe(200);

    const later = new Date(Date.UTC(2026, 9, 13, 0, 0, 0));
    expect(await runAdapterPublish(env, later)).toMatchObject({ published: true, added: 0, removedRepos: 1 });
    let files = gh.files();
    expect(Object.keys(files).filter((p) => p.startsWith(repoDir(NOTES)))).toEqual([]);
    expect(files[`${repoDir(GROUP)}/index.json`]).toBeDefined();
    expect(files["do-not-adapt.txt"]).toBe("https://github.com/Me/Notes\nhttps://codeberg.org/x/y\n");
    expect(await all("SELECT repo FROM repo_adapters")).toEqual([{ repo: GROUP }]);
    expect(await all("SELECT DISTINCT state FROM adapter_blocklist")).toEqual([{ state: "published" }]);

    expect((await block("https://codeberg.org/x/y", "DELETE")).status).toBe(200);
    await runAdapterPublish(env, new Date(Date.UTC(2026, 9, 14, 0, 0, 0)));
    files = gh.files();
    expect(files["do-not-adapt.txt"]).toBe("https://github.com/Me/Notes\n");
    expect(await all("SELECT repo FROM adapter_blocklist")).toEqual([{ repo: "https://github.com/Me/Notes" }]);
    // Nothing else to do: no further commit.
    const head = gh.head;
    expect(await runAdapterPublish(env, new Date(Date.UTC(2026, 9, 15, 0, 0, 0)))).toMatchObject({ published: false });
    expect(gh.head).toBe(head);
  });

  it("settles a list change that alters no file without an empty commit", async () => {
    await queue({ repo: NOTES, n: 1 });
    await runAdapterPublish(env, NOW);
    await block("https://codeberg.org/x/y");
    await block("https://codeberg.org/x/y", "DELETE");
    const head = gh.head;
    expect(await runAdapterPublish(env, NOW)).toMatchObject({ published: true, commit: head });
    expect(gh.head).toBe(head);
    expect(await all("SELECT * FROM adapter_blocklist")).toEqual([]);
  });
});

describe("scheduled()", () => {
  async function run(hour: number, e: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    await scheduled(
      { scheduledTime: Date.UTC(2026, 9, 12, hour, 0, 0), cron: "0 */6 * * *" },
      e as never,
      { waitUntil: (p) => waits.push(p) },
    );
    await Promise.allSettled(waits);
    return waits.length;
  }

  it("publishes on the 00:00 UTC run only", async () => {
    await queue({ repo: NOTES, n: 1 });
    const e = { ...env, BACKUPS_BUCKET: { put: async () => undefined, list: async () => ({ objects: [], truncated: false }), delete: async () => undefined } };
    expect(await run(6, e)).toBe(4);
    expect(gh.calls).toHaveLength(0);
    // 2026-10-12 is a Monday: the weekly insight is scheduled too.
    expect(await run(0, e)).toBe(6);
    expect(gh.files()[`adapters/github.com/me/notes/${sha(1)}.json`]).toBeDefined();
  });
});

describe("review once a key exists", () => {
  const MANIFEST = { schema_version: 1, name: "notes", version: "0.1.0", description: "notes", runtime: { image: "x", port: 8080 } };
  const adapterFile = (marker: string) =>
    JSON.stringify({
      ...MANIFEST,
      adapter: { version: 1, source: { repo: NOTES, base: BASE_A }, add: { "src/flagship.js": ["export {};", `// ${marker}`, ""] } },
    });
  const reviewed: string[] = [];

  beforeEach(() => {
    reviewed.length = 0;
    globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      if (req.url.startsWith(API)) return gh.handle(req);
      if (req.url.startsWith(`https://raw.githubusercontent.com/${REPO_NAME}/main/`)) {
        const body = gh.files()[req.url.slice(`https://raw.githubusercontent.com/${REPO_NAME}/main/`.length)];
        return body == null ? new Response("404", { status: 404 }) : new Response(body);
      }
      if (req.url === "https://api.anthropic.com/v1/messages") {
        const text = JSON.stringify(await req.json());
        reviewed.push(text);
        const ok = !text.includes("evil");
        return new Response(
          JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ok, reason: "x" }) }] }),
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof globalThis.fetch;
  });

  async function queueFile(n: number, text: string) {
    const key = `pending/${sha(n)}.json`;
    bucket.objects.set(key, text);
    await db
      .prepare(
        `INSERT INTO repo_adapters (file_sha256, repo, base, license, review, bytes, r2_key, confirmations, pending_confirmations, created_day)
         VALUES (?, ?, ?, 'MIT', 'rules', 10, ?, 0, 1, '2026-10-11')`,
      )
      .bind(sha(n), NOTES, BASE_A, key)
      .run();
  }

  it("without a key, everything that passed the rules goes out unreviewed", async () => {
    await queueFile(1, adapterFile("evil"));
    expect(await runAdapterPublish(env, NOW)).toMatchObject({ published: true, added: 1 });
    expect(reviewed).toEqual([]);
    expect(await all("SELECT review FROM repo_adapters")).toEqual([{ review: "rules" }]);
  });

  it("once a key is set, reviews what went out before it and withdraws what fails", async () => {
    await queueFile(1, adapterFile("fine"));
    await queueFile(2, adapterFile("evil"));
    await queueFile(3, adapterFile("also fine"));
    await runAdapterPublish(env, NOW);
    expect(Object.keys(gh.files()).filter((p) => p.endsWith(".json"))).toHaveLength(4);

    const later = new Date(Date.UTC(2026, 9, 13, 0, 0, 1));
    const r = await runAdapterPublish({ ...env, ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" }, later);
    expect(r).toMatchObject({ published: true, added: 0, withdrawn: 1 });
    expect(reviewed).toHaveLength(3);
    const files = gh.files();
    expect(files[`adapters/github.com/me/notes/${sha(2)}.json`]).toBeUndefined();
    expect(files[`adapters/github.com/me/notes/${sha(1)}.json`]).toBeDefined();
    const index = JSON.parse(files["adapters/github.com/me/notes/index.json"]!);
    expect(index.adapters.map((a: { file: string }) => a.file).sort()).toEqual([`${sha(1)}.json`, `${sha(3)}.json`]);
    expect(gh.headCommit().message).toBe("Adapters for 2026-10-13 (0 new, 0 confirmed, 1 withdrawn)");
    expect(await all("SELECT file_sha256, review, retired_day, retired_reason FROM repo_adapters ORDER BY file_sha256")).toEqual([
      { file_sha256: sha(1), review: "rules+ai", retired_day: null, retired_reason: null },
      { file_sha256: sha(2), review: "rules", retired_day: "2026-10-13", retired_reason: "review" },
      { file_sha256: sha(3), review: "rules+ai", retired_day: null, retired_reason: null },
    ]);
    expect(bucket.objects.get(`retired/${sha(2)}.json`)).toBe(adapterFile("evil"));

    // Reviewed once: the next run has nothing to do.
    reviewed.length = 0;
    expect(await runAdapterPublish({ ...env, ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" }, later)).toEqual({
      published: false,
      reason: "nothing to publish",
    });
    expect(reviewed).toEqual([]);
  });

  it("withdrawing a repo's only adapter removes its index too", async () => {
    await queueFile(1, adapterFile("evil"));
    await runAdapterPublish(env, NOW);
    await runAdapterPublish({ ...env, ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" }, new Date(Date.UTC(2026, 9, 13, 0, 0, 1)));
    expect(Object.keys(gh.files()).some((p) => p.startsWith("adapters/github.com/me/notes/"))).toBe(false);
  });

  it("with a key, a queued adapter that fails review is dropped before it is ever published", async () => {
    await queueFile(1, adapterFile("evil"));
    await queueFile(2, adapterFile("fine"));
    const r = await runAdapterPublish({ ...env, ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" }, NOW);
    expect(r).toMatchObject({ published: true, added: 1, withdrawn: 0 });
    expect(gh.files()[`adapters/github.com/me/notes/${sha(1)}.json`]).toBeUndefined();
    expect(await all("SELECT file_sha256, review FROM repo_adapters")).toEqual([{ file_sha256: sha(2), review: "rules+ai" }]);
    expect(bucket.objects.size).toBe(0);
  });
});

describe("complaints, retirement and insights", () => {
  const MANIFEST = { schema_version: 1, name: "notes", version: "0.1.0", description: "notes", runtime: { image: "x", port: 8080 } };
  const fileText = (marker: string) =>
    JSON.stringify({
      ...MANIFEST,
      adapter: { version: 1, source: { repo: NOTES, base: BASE_A }, add: { "src/flagship.js": ["export {};", `// ${marker}`, ""] } },
    });
  const KEY = { ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" };
  let prompts: string[];
  let answer: (prompt: string) => Response;

  beforeEach(() => {
    prompts = [];
    answer = (p) => verdictFor(!p.includes("evil"));
    globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      if (req.url.startsWith(API)) return gh.handle(req);
      const rawPrefix = `https://raw.githubusercontent.com/${REPO_NAME}/main/`;
      if (req.url.startsWith(rawPrefix)) {
        const body = gh.files()[req.url.slice(rawPrefix.length)];
        return body == null ? new Response("404", { status: 404 }) : new Response(body);
      }
      if (req.url === "https://api.anthropic.com/v1/messages") {
        const text = JSON.stringify(await req.json());
        prompts.push(text);
        return answer(text);
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof globalThis.fetch;
  });

  function verdictFor(ok: boolean): Response {
    return new Response(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({ ok, category: ok ? "none" : "sends data out of the server" }) }],
      }),
    );
  }

  async function publishFiles(...markers: string[]) {
    for (const [i, m] of markers.entries()) {
      const key = `pending/${sha(i + 1)}.json`;
      bucket.objects.set(key, fileText(m));
      await db
        .prepare(
          `INSERT INTO repo_adapters (file_sha256, repo, base, license, review, bytes, r2_key, confirmations, pending_confirmations, created_day)
           VALUES (?, ?, ?, 'MIT', 'rules+ai', 10, ?, 0, 1, '2026-10-10')`,
        )
        .bind(sha(i + 1), NOTES, BASE_A, key)
        .run();
    }
    await runAdapterPublish(env, new Date(Date.UTC(2026, 9, 11, 0, 0, 0)));
  }

  async function complaint(n: number, stage: string, detail: string | null = null, day = "2026-10-11") {
    await db
      .prepare("INSERT INTO adapter_complaints (file_sha256, stage, detail, day) VALUES (?, ?, ?, ?)")
      .bind(sha(n), stage, detail, day)
      .run();
  }

  const index = () => JSON.parse(gh.files()["adapters/github.com/me/notes/index.json"]!) as {
    adapters: Array<{ file: string; complaints: number; confirmations: number }>;
  };

  it("counts build and start complaints into index.json and sorts failing adapters last", async () => {
    await publishFiles("one", "two");
    await complaint(1, "build");
    await complaint(1, "start");
    await complaint(2, "report", "the page is blank");
    const r = await runAdapterPublish(env, NOW);
    expect(r).toMatchObject({ published: true, added: 0, withdrawn: 0 });
    const entries = index().adapters;
    expect(entries.map((e) => [e.file, e.complaints])).toEqual([
      [`${sha(2)}.json`, 0],
      [`${sha(1)}.json`, 2],
    ]);
    // Counted once: nothing more to publish.
    expect(await runAdapterPublish(env, NOW)).toEqual({ published: false, reason: "nothing to publish" });
    // The note itself is never published.
    expect(JSON.stringify(gh.files())).not.toContain("the page is blank");
  });

  it("retires an adapter at three complaints of any kind, keeping its row and complaints", async () => {
    await publishFiles("one", "two");
    await db.prepare(`UPDATE repo_adapters SET confirmations = 9 WHERE file_sha256 = '${sha(1)}'`).bind().run();
    await complaint(1, "build");
    await complaint(1, "start");
    await complaint(1, "report", "crashes on login");
    await complaint(2, "build");
    await complaint(2, "build");
    const r = await runAdapterPublish(env, NOW);
    expect(r).toMatchObject({ published: true, withdrawn: 1 });
    expect(gh.headCommit().message).toBe(`Adapters for ${DAY} (0 new, 0 confirmed, 1 withdrawn)`);
    expect(gh.files()[`adapters/github.com/me/notes/${sha(1)}.json`]).toBeUndefined();
    expect(index().adapters.map((e) => e.file)).toEqual([`${sha(2)}.json`]);
    expect(await all(`SELECT retired_day, retired_reason FROM repo_adapters WHERE file_sha256 = '${sha(1)}'`)).toEqual([
      { retired_day: DAY, retired_reason: "reports" },
    ]);
    expect(await all(`SELECT count(*) AS n FROM adapter_complaints WHERE file_sha256 = '${sha(1)}'`)).toEqual([{ n: 3 }]);
    expect(bucket.objects.get(`retired/${sha(1)}.json`)).toBe(fileText("one"));
  });

  it("retiring a repo's last adapter removes its index", async () => {
    await publishFiles("one");
    for (const s of ["build", "build", "start"]) await complaint(1, s);
    await runAdapterPublish(env, NOW);
    expect(Object.keys(gh.files()).some((p) => p.startsWith("adapters/github.com/me/notes/"))).toBe(false);
  });

  it("without a key, owners' reports are only stored", async () => {
    await publishFiles("one");
    await complaint(1, "report", "it sends my files somewhere");
    expect(await runAdapterPublish(env, NOW)).toEqual({ published: false, reason: "nothing to publish" });
    expect(prompts).toEqual([]);
    expect(await all("SELECT reviewed FROM adapter_complaints")).toEqual([{ reviewed: 0 }]);
  });

  it("with a key, a reported adapter is reviewed again once, with the reports as untrusted text", async () => {
    await publishFiles("one");
    await complaint(1, "report", "it sends my files somewhere");
    await runAdapterPublish({ ...env, ...KEY }, NOW);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("<user_reports>");
    expect(prompts[0]).toContain("it sends my files somewhere");
    expect(prompts[0]).toMatch(/untrusted/);
    expect(await all("SELECT reviewed FROM adapter_complaints")).toEqual([{ reviewed: 1 }]);
    prompts.length = 0;
    await runAdapterPublish({ ...env, ...KEY }, NOW);
    expect(prompts).toEqual([]);
    // A new report earns another review.
    await complaint(1, "report", "still odd");
    await runAdapterPublish({ ...env, ...KEY }, NOW);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("still odd");
    expect(prompts[0]).not.toContain("it sends my files somewhere");
  });

  it("a re-review that fails retires the adapter for review; one that can't run changes nothing", async () => {
    await publishFiles("one");
    await complaint(1, "report", "odd");
    answer = () => new Response("overloaded", { status: 529 });
    await runAdapterPublish({ ...env, ...KEY }, NOW);
    expect(await all("SELECT retired_day FROM repo_adapters")).toEqual([{ retired_day: null }]);
    expect(await all("SELECT reviewed FROM adapter_complaints")).toEqual([{ reviewed: 0 }]);
    answer = () => verdictFor(false);
    expect(await runAdapterPublish({ ...env, ...KEY }, NOW)).toMatchObject({ withdrawn: 1 });
    expect(await all("SELECT retired_reason FROM repo_adapters")).toEqual([{ retired_reason: "review" }]);
    expect(gh.files()[`adapters/github.com/me/notes/${sha(1)}.json`]).toBeUndefined();
  });

  it("a catch-up review that can't run no longer withdraws", async () => {
    await publishFiles("one");
    await db.prepare("UPDATE repo_adapters SET review = 'rules'").bind().run();
    answer = () => new Response("down", { status: 500 });
    await runAdapterPublish({ ...env, ...KEY }, NOW);
    expect(await all("SELECT review, retired_day FROM repo_adapters")).toEqual([{ review: "rules", retired_day: null }]);
  });

  it("prunes live complaints after 90 days, retired adapters after 180, attempts after 7", async () => {
    await publishFiles("one", "two");
    await complaint(1, "report", "old note", "2026-07-13");
    await complaint(1, "build", null, "2026-07-14");
    await complaint(2, "build", null, "2026-10-11");
    await db
      .prepare(`UPDATE repo_adapters SET published_day = '2026-03-01', retired_day = '2026-04-01', retired_reason = 'reports' WHERE file_sha256 = '${sha(2)}'`)
      .bind()
      .run();
    bucket.objects.set(`retired/${sha(2)}.json`, "{}");
    await db.prepare("INSERT INTO adapter_attempts (repo, base, day, count) VALUES (?, ?, '2026-10-04', 3), (?, ?, '2026-10-05', 1)").bind(NOTES, BASE_A, NOTES, BASE_B).run();
    await runAdapterPublish(env, NOW);
    expect(await all("SELECT file_sha256, day FROM adapter_complaints ORDER BY id")).toEqual([{ file_sha256: sha(1), day: "2026-07-14" }]);
    expect(await all("SELECT file_sha256 FROM repo_adapters")).toEqual([{ file_sha256: sha(1) }]);
    expect(bucket.objects.has(`retired/${sha(2)}.json`)).toBe(false);
    expect(await all("SELECT day FROM adapter_attempts")).toEqual([{ day: "2026-10-05" }]);
    // The published count is the build complaint still inside the 90 days.
    expect(index().adapters.find((e) => e.file === `${sha(1)}.json`)!.complaints).toBe(1);
  });

  it("prunes even when publishing isn't configured", async () => {
    await complaint(7, "report", "old", "2026-01-01");
    expect(await runAdapterPublish({ DB: db }, NOW)).toEqual({ published: false, reason: "not configured" });
    expect(await all("SELECT * FROM adapter_complaints")).toEqual([]);
  });

  it("listing a repo forgets its retired adapters too", async () => {
    await publishFiles("one", "two");
    for (const s of ["build", "build", "start"]) await complaint(1, s);
    await runAdapterPublish(env, NOW);
    await block(NOTES);
    await runAdapterPublish(env, new Date(Date.UTC(2026, 9, 13, 0, 0, 0)));
    expect(await all("SELECT * FROM repo_adapters")).toEqual([]);
    expect(await all("SELECT * FROM adapter_complaints")).toEqual([]);
    expect(bucket.objects.has(`retired/${sha(1)}.json`)).toBe(false);
  });

  describe("weekly insight", () => {
    const insightAnswer = {
      patterns: [{ what_went_wrong: "listens on a fixed port", how_often: 2 }],
      harness_suggestions: [{ area: "adapt prompt", suggestion: "map the app's port to runtime.port" }],
    };

    async function retireOne(n: number, marker: string, day: string, reason = "reports") {
      bucket.objects.set(`retired/${sha(n)}.json`, fileText(marker));
      await db
        .prepare(
          `INSERT INTO repo_adapters (file_sha256, repo, base, license, review, bytes, confirmations, pending_confirmations, created_day, published_day, retired_day, retired_reason)
           VALUES (?, ?, ?, 'MIT', 'rules', 10, 1, 0, '2026-09-01', '2026-09-02', ?, ?)`,
        )
        .bind(sha(n), NOTES, BASE_A, day, reason)
        .run();
    }

    it("does nothing without a key or without retirements", async () => {
      await retireOne(1, "one", "2026-10-10");
      expect(await runAdapterInsights({ DB: db, ADAPTERS_BUCKET: bucket }, NOW)).toEqual({ stored: false, reason: "not configured" });
      await db.prepare("DELETE FROM repo_adapters").bind().run();
      expect(await runAdapterInsights({ DB: db, ADAPTERS_BUCKET: bucket, ...KEY }, NOW)).toEqual({
        stored: false,
        reason: "nothing retired",
      });
      expect(prompts).toEqual([]);
    });

    it("summarizes the week's retirements privately, with reports marked untrusted", async () => {
      await retireOne(1, "fixed port", "2026-10-08");
      await retireOne(2, "another", "2026-10-11", "review");
      await complaint(1, "build");
      await complaint(1, "report", "fails at boot, my email is me@example.com");
      answer = () =>
        new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(insightAnswer) }] }));
      const r = await runAdapterInsights({ DB: db, ADAPTERS_BUCKET: bucket, ...KEY }, NOW);
      expect(r).toMatchObject({ stored: true, retired: 2 });
      expect(prompts).toHaveLength(1);
      const sent = JSON.parse(prompts[0]!);
      expect(sent.model).toBe("claude-haiku-5-5");
      expect(sent.system).toMatch(/Never quote or paraphrase anything from the user reports that could identify/);
      expect(sent.output_config.format.schema.required).toEqual(["patterns", "harness_suggestions"]);
      const content = sent.messages[0].content as string;
      expect(content).toContain("<user_reports>");
      expect(content).toContain("Retired because of: problem reports");
      expect(content).toContain("Retired because of: a failed review");
      expect(content).toMatch(/Complaints: build 1, report 1/);
      expect(content).toContain("fixed port");
      expect(await all("SELECT day, json FROM adapter_insights")).toEqual([{ day: DAY, json: JSON.stringify(insightAnswer) }]);
      // The same day again finds nothing new; nothing went public.
      prompts.length = 0;
      expect(await runAdapterInsights({ DB: db, ADAPTERS_BUCKET: bucket, ...KEY }, NOW)).toMatchObject({ stored: false });
      expect(gh.calls).toHaveLength(0);
    });

    it("a failed call stores nothing, so next week covers both weeks", async () => {
      await retireOne(1, "one", "2026-10-08");
      answer = () => new Response("down", { status: 500 });
      expect(await runAdapterInsights({ DB: db, ADAPTERS_BUCKET: bucket, ...KEY }, NOW)).toMatchObject({ stored: false });
      await retireOne(2, "two", "2026-10-15");
      answer = () =>
        new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(insightAnswer) }] }));
      expect(await runAdapterInsights({ DB: db, ADAPTERS_BUCKET: bucket, ...KEY }, new Date(Date.UTC(2026, 9, 19)))).toMatchObject({
        stored: true,
        retired: 2,
      });
    });
  });
});

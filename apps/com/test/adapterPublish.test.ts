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
        { base: BASE_A, file: `${sha(1)}.json`, added: DAY, confirmations: 2 },
        { base: BASE_B, file: `${sha(2)}.json`, added: DAY, confirmations: 1 },
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
      { base: BASE_B, file: `${sha(2)}.json`, added: "2026-10-13", confirmations: 1 },
      { base: BASE_A, file: `${sha(1)}.json`, added: DAY, confirmations: 5 },
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
    expect(await run(0, e)).toBe(5);
    expect(gh.files()[`adapters/github.com/me/notes/${sha(1)}.json`]).toBeDefined();
  });
});

describe("review once a key exists", () => {
  const MANIFEST = { schema_version: 1, name: "notes", version: "0.1.0", description: "notes", runtime: { image: "x", port: 8080 } };
  const adapterFile = (marker: string) =>
    JSON.stringify({
      ...MANIFEST,
      adapter: { version: 1, source: { repo: NOTES, base: BASE_A }, add: { Dockerfile: ["FROM node:20", `# ${marker}`, ""] } },
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
    expect(gh.headCommit().message).toBe("Adapters for 2026-10-13 (0 new, 0 confirmed, 1 withdrawn after review)");
    expect(await all("SELECT file_sha256, review FROM repo_adapters ORDER BY file_sha256")).toEqual([
      { file_sha256: sha(1), review: "rules+ai" },
      { file_sha256: sha(3), review: "rules+ai" },
    ]);

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

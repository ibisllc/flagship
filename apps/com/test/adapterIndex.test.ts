/**
 * The repo adapter index's submit side (src/adapterIndex.ts) over a real D1-over-sqlite
 * binding with every migration applied, an in-memory R2 bucket, and a mocked
 * fetch standing in for the git hosts' raw URLs and the Anthropic API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAdapterFile, deriveRepoAdapter } from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  handleAdapterIndex,
  identifyLicense,
  MAX_ATTEMPTS_PER_DAY,
  REVIEW_CATEGORIES,
  type AdapterBucketLike,
  type AdapterIndexEnv,
} from "../src/adapterIndex.js";
import { route, type RouteEnv } from "../src/route.js";

const ORIGIN = "https://flagshipserver.com";
const REPO = "https://github.com/me/notes";
const BASE = "a".repeat(40);
const OTHER_BASE = "b".repeat(40);
const RAW = `https://raw.githubusercontent.com/me/notes/${BASE}/`;
const ADMIN = "admin-secret";

const MIT = `MIT License

Copyright (c) 2024 Me

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
`;

const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { image: "x", port: 8080 },
});

const ORIGINAL: Record<string, string> = {
  "index.js": "const a = 1;\nconst b = 2;\nconst port = 3000;\napp.listen(port);\nconst c = 3;\n",
  "README.md": "# Notes\n",
  "old.txt": "gone\n",
};
const ADAPTED: Record<string, string> = {
  "index.js": "const a = 1;\nconst b = 2;\nconst port = process.env.PORT;\napp.listen(port);\nconst c = 3;\n",
  "README.md": "# Notes\n",
  "src/flagship.js": "export const port = Number(process.env.PORT);\n",
};

function adapterFile(opts: { repo?: string; base?: string; adapted?: Record<string, string>; manifest?: string } = {}): string {
  const adapter = deriveRepoAdapter(ORIGINAL, opts.adapted ?? ADAPTED, {
    repo: opts.repo ?? REPO,
    base: opts.base ?? BASE,
  });
  return buildAdapterFile(opts.manifest ?? MANIFEST, adapter);
}

// ---- fakes -----------------------------------------------------------------

let raw: Map<string, string>;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let anthropic: () => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  raw = new Map([
    [`${RAW}LICENSE`, MIT],
    ...Object.entries(ORIGINAL).map(([p, c]) => [`${RAW}${p}`, c] as [string, string]),
  ]);
  fetchCalls = [];
  anthropic = () => verdict(true);
  globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    fetchCalls.push({ url, ...(init ? { init } : {}) });
    if (url === "https://api.anthropic.com/v1/messages") return anthropic();
    const body = raw.get(url);
    return body == null ? new Response("404: Not Found", { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function verdict(ok: boolean): Response {
  return new Response(
    JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ ok, reason: ok ? "fine" : "phones home" }) }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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

interface Fixture {
  env: AdapterIndexEnv;
  db: D1Database;
  bucket: MemoryBucket;
  pending: Promise<unknown>[];
  close: () => void;
}

let fx: Fixture;

function makeFixture(extra: Partial<AdapterIndexEnv> = {}): Fixture {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const bucket = new MemoryBucket();
  return {
    env: { DB: db, ADAPTERS_BUCKET: bucket, FLAGSHIP_ADMIN_SECRET: ADMIN, ...extra },
    db,
    bucket,
    pending: [],
    close: () => sqlite.close(),
  };
}

beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.close());

function post(path: string, body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(req: Request, f: Fixture = fx): Promise<Response> {
  return handleAdapterIndex(req, f.env, { waitUntil: (p) => f.pending.push(p) });
}

async function submit(body: Record<string, unknown>, f: Fixture = fx): Promise<Response> {
  const res = await call(post("/api/adapters/submit", body), f);
  await Promise.all(f.pending.splice(0));
  return res;
}

function submission(over: Record<string, unknown> = {}) {
  return { repo: REPO, base: BASE, licensePath: "LICENSE", file: adapterFile(), ...over };
}

async function rows(f: Fixture = fx) {
  const r = await f.db.prepare("SELECT * FROM repo_adapters ORDER BY file_sha256").bind().all<Record<string, unknown>>();
  return r.results;
}

const ACCEPTED = JSON.stringify({ received: true });

// ---- submit ----------------------------------------------------------------

describe("POST /api/adapters/submit", () => {
  it("400s unless the body is JSON with the four strings", async () => {
    for (const body of ["nope", {}, { ...submission(), file: 1 }, { repo: REPO, base: BASE, file: "x" }]) {
      const res = await call(post("/api/adapters/submit", body));
      expect(res.status).toBe(400);
    }
    expect(fx.pending).toHaveLength(0);
  });

  it("queues a public, MIT-licensed adapter whose edits fit base exactly", async () => {
    const file = adapterFile();
    const res = await submit(submission({ file }));
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [row, ...more] = await rows();
    expect(more).toHaveLength(0);
    expect(row).toMatchObject({
      repo: REPO,
      base: BASE,
      license: "MIT",
      review: "rules",
      confirmations: 0,
      pending_confirmations: 1,
      published_day: null,
      r2_key: `pending/${row!.file_sha256}.json`,
    });
    expect(row!.created_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(row!).sort()).toEqual([
      "base", "bytes", "confirmations", "created_day", "file_sha256", "license",
      "pending_confirmations", "published_day", "r2_key", "repo", "retired_day", "retired_reason", "review",
    ]);
    expect(fx.bucket.objects.get(`pending/${row!.file_sha256}.json`)).toBe(file);
    // Every check read the public raw URL at base, without following redirects.
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const c of fetchCalls) {
      expect(c.url.startsWith(RAW)).toBe(true);
      expect(c.init?.redirect).toBe("manual");
    }
    expect(fetchCalls.map((c) => c.url)).toEqual(
      expect.arrayContaining([`${RAW}LICENSE`, `${RAW}flagship.app.json`, `${RAW}index.js`, `${RAW}old.txt`]),
    );
  });

  it("answers identically whether the submission is stored, rejected or blocked", async () => {
    const stored = await submit(submission());
    const rejected = await submit(submission({ file: "{not json" }));
    await call(post("/api/admin/adapter-blocklist", { repo: "https://github.com/me/other" }, { "x-admin-secret": ADMIN }));
    const blocked = await submit(submission({ repo: "https://github.com/me/other" }));
    for (const r of [stored, rejected, blocked]) {
      expect(r.status).toBe(202);
      expect(await r.text()).toBe(ACCEPTED);
      expect([...r.headers.entries()].sort()).toEqual([...stored.headers.entries()].sort());
    }
  });

  it("answers before the checks run (no oracle in the timing of the reply)", async () => {
    const res = await call(post("/api/adapters/submit", submission()));
    expect(res.status).toBe(202);
    expect(await rows()).toHaveLength(0);
    await Promise.all(fx.pending.splice(0));
    expect(await rows()).toHaveLength(1);
  });

  it("counts a byte-identical resubmission as a confirmation, pending or published", async () => {
    await submit(submission());
    const before = fetchCalls.length;
    await submit(submission());
    const [row, ...more] = await rows();
    expect(more).toHaveLength(0);
    expect(row!.pending_confirmations).toBe(2);
    await fx.db
      .prepare("UPDATE repo_adapters SET published_day = '2026-10-01', confirmations = 2, pending_confirmations = 0, r2_key = NULL")
      .bind()
      .run();
    await submit(submission());
    expect((await rows())[0]).toMatchObject({ confirmations: 2, pending_confirmations: 1 });
    expect(fx.bucket.objects.size).toBe(1);
    expect(fetchCalls.length).toBe(before);
  });

  it("keeps a different file for the same repo as its own entry", async () => {
    await submit(submission());
    await submit(submission({ file: adapterFile({ adapted: { ...ADAPTED, "src/flagship.js": "export const port = 8080;\n" } }) }));
    expect(await rows()).toHaveLength(2);
  });

  it("accepts any spelling of the repo that normalizes to the adapter's", async () => {
    await submit(submission({ repo: "https://GitHub.com/me/notes.git" }));
    expect(await rows()).toHaveLength(1);
  });

  it("queues an adapter that changes nothing but the manifest", async () => {
    const file = adapterFile({ adapted: ORIGINAL });
    await submit(submission({ file }));
    expect(await rows()).toHaveLength(1);
  });

  it("drops a repo with no recognised license", async () => {
    raw.delete(`${RAW}LICENSE`);
    await submit(submission());
    expect(await rows()).toHaveLength(0);
    raw.set(`${RAW}LICENSE`, "Copyright (c) Me. All rights reserved.");
    await submit(submission());
    expect(await rows()).toHaveLength(0);
    raw.set(`${RAW}LICENSE`, "Business Source License 1.1\nChange License: Apache License, Version 2.0\n");
    await submit(submission());
    expect(await rows()).toHaveLength(0);
  });

  it("falls back to the conventional license names when licensePath fails", async () => {
    raw.delete(`${RAW}LICENSE`);
    raw.set(`${RAW}COPYING`, "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n");
    await submit(submission({ licensePath: "docs/../../etc/passwd" }));
    expect((await rows())[0]).toMatchObject({ license: "GPL-3.0" });
    expect(fetchCalls.some((c) => c.url.includes("passwd"))).toBe(false);
  });

  it("drops an adapter that edits or removes the license it would be kept under", async () => {
    const file = adapterFile({ adapted: { ...ADAPTED, LICENSE: "mine now\n" } });
    raw.set(`${RAW}LICENSE`, MIT);
    const original = { ...ORIGINAL, LICENSE: MIT };
    const adapter = deriveRepoAdapter(original, { ...ADAPTED }, { repo: REPO, base: BASE });
    expect(adapter.remove).toContain("LICENSE");
    await submit(submission({ file: buildAdapterFile(MANIFEST, adapter) }));
    await submit(submission({ file }));
    expect(await rows()).toHaveLength(0);
  });

  it("drops a repo that carries its own flagship.app.json", async () => {
    raw.set(`${RAW}flagship.app.json`, MANIFEST);
    await submit(submission());
    expect(await rows()).toHaveLength(0);
  });

  it("drops an edit that doesn't fit base exactly", async () => {
    raw.set(`${RAW}index.js`, `// moved\n${ORIGINAL["index.js"]}`);
    await submit(submission());
    expect(await rows()).toHaveLength(0);
    raw.set(`${RAW}index.js`, "something else entirely\n");
    await submit(submission());
    expect(await rows()).toHaveLength(0);
  });

  it("drops an adapter that edits or removes a file that isn't public at base", async () => {
    raw.delete(`${RAW}index.js`);
    await submit(submission());
    expect(await rows()).toHaveLength(0);
    raw.set(`${RAW}index.js`, ORIGINAL["index.js"]!);
    raw.delete(`${RAW}old.txt`);
    await submit(submission());
    expect(await rows()).toHaveLength(0);
  });

  it("drops a file whose adapter names another repo or commit", async () => {
    await submit(submission({ file: adapterFile({ repo: "https://github.com/me/else" }) }));
    await submit(submission({ file: adapterFile({ base: OTHER_BASE }) }));
    await submit(submission({ base: OTHER_BASE }));
    expect(await rows()).toHaveLength(0);
  });

  it("drops a file with no adapter, a bad manifest, or a secret", async () => {
    await submit(submission({ file: MANIFEST }));
    await submit(submission({ file: adapterFile({ manifest: JSON.stringify({ name: "x" }) }) }));
    await submit(
      submission({ file: adapterFile({ adapted: { ...ADAPTED, ".env": "KEY=AKIAABCDEFGHIJKLMNOP\n" } }) }),
    );
    expect(await rows()).toHaveLength(0);
  });

  it("keeps an adapter that only moves a secret the public repo already has", async () => {
    const key = "AKIAABCDEFGHIJKLMNOP";
    const original = { ...ORIGINAL, "old.txt": `KEY=${key}\n` };
    raw.set(`${RAW}old.txt`, original["old.txt"]);
    const moved = buildAdapterFile(
      MANIFEST,
      deriveRepoAdapter(original, { ...ADAPTED, "config/keys.txt": `KEY=${key}\n` }, { repo: REPO, base: BASE }),
    );
    await submit(submission({ file: moved }));
    expect(await rows()).toHaveLength(1);
  });

  it("drops an adapter that names a box's own address", async () => {
    await submit(
      submission({ file: adapterFile({ adapted: { ...ADAPTED, ".env": "HOST=home.harry.flagship.services\n" } }) }),
    );
    expect(await rows()).toHaveLength(0);
  });

  it("drops repos on hosts we can't check, and odd repo shapes", async () => {
    for (const repo of ["https://example.com/me/notes", "https://github.com/me/notes/extra", "https://gitlab.com/g/-/x"]) {
      await submit(submission({ repo, file: adapterFile({ repo }) }));
    }
    expect(await rows()).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("checks GitLab (with subgroups) and Codeberg at their raw URLs", async () => {
    for (const [repo, prefix] of [
      ["https://gitlab.com/group/sub/app", `https://gitlab.com/group/sub/app/-/raw/${BASE}/`],
      ["https://codeberg.org/me/app", `https://codeberg.org/me/app/raw/commit/${BASE}/`],
    ] as const) {
      raw.set(`${prefix}LICENSE`, MIT);
      for (const [p, c] of Object.entries(ORIGINAL)) raw.set(`${prefix}${p}`, c);
      await submit(submission({ repo, file: adapterFile({ repo }) }));
    }
    expect((await rows()).map((r) => r.repo).sort()).toEqual(["https://codeberg.org/me/app", "https://gitlab.com/group/sub/app"]);
  });

  it("does not follow a redirect (a private GitLab project redirects to sign-in)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://gitlab.com/users/sign_in" } }),
    ) as typeof globalThis.fetch;
    await submit(submission({ repo: "https://gitlab.com/group/private", file: adapterFile({ repo: "https://gitlab.com/group/private" }) }));
    expect(await rows()).toHaveLength(0);
  });
});

// ---- AI review -------------------------------------------------------------

describe("AI review", () => {
  it("is skipped without the secret", async () => {
    await submit(submission());
    expect(fetchCalls.some((c) => c.url.includes("anthropic"))).toBe(false);
    expect((await rows())[0]!.review).toBe("rules");
  });

  it("runs with the secret and records it", async () => {
    const f = makeFixture({ ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" });
    try {
      await submit(submission(), f);
      const ai = fetchCalls.find((c) => c.url === "https://api.anthropic.com/v1/messages");
      expect(ai).toBeDefined();
      const headers = new Headers(ai!.init!.headers);
      expect(headers.get("x-api-key")).toBe("sk-test");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(ai!.init!.body as string);
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.max_tokens).toBe(400);
      expect(body.messages[0].content).toContain("index.js");
      expect((await rows(f))[0]!.review).toBe("rules+ai");
    } finally {
      f.close();
    }
  });

  it("drops on a rejecting verdict, an API error, or a garbled answer", async () => {
    const f = makeFixture({ ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" });
    try {
      anthropic = () => verdict(false);
      await submit(submission(), f);
      anthropic = () => new Response("overloaded", { status: 529 });
      await submit(submission(), f);
      anthropic = () =>
        new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "sure!" }] }), { status: 200 });
      await submit(submission(), f);
      expect(await rows(f)).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("says so when the adaptation had to be cut", async () => {
    const f = makeFixture({ ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" });
    try {
      const big = Array.from({ length: 20_000 }, (_, i) => `line ${i} of a long generated file`).join("\n");
      await submit(submission({ file: adapterFile({ adapted: { ...ADAPTED, "big.txt": big } }) }), f);
      const ai = fetchCalls.find((c) => c.url.includes("anthropic"))!;
      const content = JSON.parse(ai.init!.body as string).messages[0].content as string;
      expect(content.length).toBeLessThan(151_000);
      expect(content).toMatch(/only the first 150000 are shown/);
    } finally {
      f.close();
    }
  });
});

// ---- do-not-adapt list -----------------------------------------------------

describe("/api/admin/adapter-blocklist", () => {
  const block = (repo: string, headers: Record<string, string> = { "x-admin-secret": ADMIN }, method = "POST") =>
    call(post("/api/admin/adapter-blocklist", { repo, note: "owner email 2026-10-11" }, headers, method));

  it("is admin-gated", async () => {
    expect((await block(REPO, {})).status).toBe(401);
    expect((await block(REPO, { "x-admin-secret": "wrong" })).status).toBe(403);
    const f = makeFixture({ FLAGSHIP_ADMIN_SECRET: undefined });
    try {
      expect((await call(post("/api/admin/adapter-blocklist", { repo: REPO }, { "x-admin-secret": ADMIN }), f)).status).toBe(503);
    } finally {
      f.close();
    }
    expect((await call(new Request(`${ORIGIN}/api/admin/adapter-blocklist`, { headers: { "x-admin-secret": ADMIN } }))).status).toBe(405);
  });

  it("400s on a bad repo", async () => {
    expect((await block("not a repo")).status).toBe(400);
  });

  it("adding drops the queue for it, case-insensitively, and blocks new submissions", async () => {
    await submit(submission());
    await submit(submission({ file: adapterFile({ adapted: { ...ADAPTED, "src/flagship.js": "export const port = 8080;\n" } }) }));
    expect(fx.bucket.objects.size).toBe(2);
    const res = await block("https://github.com/Me/Notes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repo: "https://github.com/Me/Notes", blocked: true, droppedPending: 2 });
    expect(await rows()).toHaveLength(0);
    expect(fx.bucket.objects.size).toBe(0);
    await submit(submission());
    expect(await rows()).toHaveLength(0);
    const listed = await fx.db.prepare("SELECT * FROM adapter_blocklist").bind().all<Record<string, unknown>>();
    expect(listed.results).toEqual([
      {
        repo: "https://github.com/Me/Notes",
        note: "owner email 2026-10-11",
        added_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        state: "pending",
      },
    ]);
  });

  it("adding keeps published rows for the next publish to take out, but stops counting them", async () => {
    await submit(submission());
    await fx.db.prepare("UPDATE repo_adapters SET published_day = '2026-10-01', pending_confirmations = 3, r2_key = NULL").bind().run();
    await block(REPO);
    expect((await rows())[0]).toMatchObject({ published_day: "2026-10-01", pending_confirmations: 0 });
  });

  it("removing lets submissions in again", async () => {
    await block(REPO);
    const res = await block(REPO, { "x-admin-secret": ADMIN }, "DELETE");
    expect(await res.json()).toEqual({ repo: REPO, blocked: false, removed: true });
    const state = await fx.db.prepare("SELECT state FROM adapter_blocklist").bind().first<{ state: string }>();
    expect(state?.state).toBe("unlisting");
    await submit(submission());
    expect(await rows()).toHaveLength(1);
  });
});

// ---- license heuristics ----------------------------------------------------

describe("identifyLicense", () => {
  it.each([
    [MIT, "MIT"],
    ["                                 Apache License\n                           Version 2.0, January 2004\n", "Apache-2.0"],
    ["Mozilla Public License Version 2.0\n... \"Secondary License\" means either the GNU General Public License, Version 2.0, the GNU Lesser General Public License, Version 2.1, the GNU Affero General Public License, Version 3.0", "MPL-2.0"],
    ["Eclipse Public License - v 2.0\n... GNU General Public License, Version 2.0", "EPL-2.0"],
    ["GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007", "AGPL-3.0"],
    ["GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007", "LGPL-3.0"],
    ["GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999", "LGPL-2.1"],
    ["GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991", "GPL-2.0"],
    ["Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n1. Redistributions of source code must retain...\n2. Redistributions in binary form must reproduce...\n3. Neither the name of the copyright holder nor ...", "BSD-3-Clause"],
    ["Redistribution and use in source and binary forms, with or without modification, are permitted provided that ...\n2. Redistributions in binary form must reproduce the above", "BSD-2-Clause"],
    ["Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.", "ISC"],
    ["Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\"", "0BSD"],
    ["This is free and unencumbered software released into the public domain.", "Unlicense"],
    ["This software is provided 'as-is', without any express or implied warranty. ... 2. Altered source versions must be plainly marked as such", "Zlib"],
    ["Boost Software License - Version 1.0 - August 17th, 2003", "BSL-1.0"],
    ["// SPDX-License-Identifier: GPL-3.0-or-later\n", "GPL-3.0"],
  ])("recognises %#", (text, id) => {
    expect(identifyLicense(text)).toBe(id);
  });

  it.each([
    ["Copyright 2024. All rights reserved."],
    ["Business Source License 1.1 ... Change License: GNU General Public License v2.0 or later"],
    ["Apache License Version 2.0 with Commons Clause"],
    ["Server Side Public License VERSION 1"],
    ["Redistribution and use in source and binary forms, with or without modification, are permitted ... 3. All advertising materials mentioning features"],
    ["Eclipse Public License - v 1.0"],
  ])("rejects %#", (text) => {
    expect(identifyLicense(text)).toBeNull();
  });
});

// ---- route wiring ----------------------------------------------------------

describe("route() wiring", () => {
  function routeEnv(): RouteEnv {
    return {
      SERVICES_BASE_URL: "https://flagship.services",
      ASSETS: { fetch: async () => new Response("asset") },
      DB: fx.db,
      ADAPTERS_BUCKET: fx.bucket,
      FLAGSHIP_ADMIN_SECRET: ADMIN,
    };
  }

  it("serves the index on the apex without touching .services", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    const res = await route(post("/api/adapters/submit", submission()), routeEnv(), ctx);
    expect(res.status).toBe(202);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await rows()).toHaveLength(1);
    expect(fetchCalls.some((c) => c.url.startsWith("https://flagship.services"))).toBe(false);
  });

  it("serves complaints and the admin insights here too", async () => {
    const complaint = await route(post("/api/adapters/complain", { repo: REPO, file: "a".repeat(64), stage: "build" }), routeEnv());
    expect(complaint.status).toBe(202);
    const insights = await route(new Request(`${ORIGIN}/api/admin/adapter-insights`, { headers: { "x-admin-secret": ADMIN } }), routeEnv());
    expect(insights.status).toBe(200);
    expect(fetchCalls.some((c) => c.url.startsWith("https://flagship.services"))).toBe(false);
  });

  it("404s any other /api/adapters path (there is no lookup) instead of proxying it", async () => {
    for (const path of ["/api/adapters/lookup", "/api/adapters/list", "/api/adapters", "/api/adapters/"]) {
      const res = await route(new Request(`${ORIGIN}${path}`), routeEnv());
      expect(res.status, path).toBe(404);
    }
    expect(fetchCalls).toHaveLength(0);
  });
});


// ---- wait mode: the verdict ------------------------------------------------

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface VerdictBody {
  status: string;
  file: string;
  reasons?: Array<{ code: string; message: string; fixable: boolean }>;
}

async function ask(over: Record<string, unknown> = {}, f: Fixture = fx): Promise<{ res: Response; body: VerdictBody }> {
  const res = await call(post("/api/adapters/submit", { ...submission(over), wait: true }), f);
  return { res, body: (await res.json()) as VerdictBody };
}

const codes = (b: VerdictBody) => (b.reasons ?? []).map((r) => r.code);

function categoryVerdict(ok: boolean, category: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ok, category, ...extra }) }] }),
    { status: 200 },
  );
}

describe("POST /api/adapters/submit with wait", () => {
  it("answers kept, then known, with the file's sha256 and no reasons", async () => {
    const file = adapterFile();
    const first = await ask({ file });
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toEqual({ status: "kept", file: await sha256(file) });
    expect(await rows()).toHaveLength(1);
    expect((await ask({ file })).body).toEqual({ status: "known", file: await sha256(file) });
    expect((await rows())[0]!.pending_confirmations).toBe(2);
    expect(fx.pending).toHaveLength(0);
  });

  it("400s on a wait that isn't a boolean", async () => {
    expect((await call(post("/api/adapters/submit", { ...submission(), wait: "yes" }))).status).toBe(400);
  });

  it("refuses with the reason a box can't fix", async () => {
    const cases: Array<[Record<string, unknown>, string, () => void]> = [
      [{ repo: "https://example.com/me/notes", file: adapterFile({ repo: "https://example.com/me/notes" }) }, "unsupported-host", () => {}],
      [{ file: "{nope" }, "malformed", () => {}],
      [{ file: MANIFEST }, "malformed", () => {}],
      [{ file: adapterFile({ base: OTHER_BASE }) }, "wrong-source", () => {}],
      [{}, "no-license", () => raw.delete(`${RAW}LICENSE`)],
      [{}, "repo-has-own-file", () => raw.set(`${RAW}flagship.app.json`, MANIFEST)],
      [{}, "edits-dont-fit", () => raw.set(`${RAW}index.js`, "changed\n")],
    ];
    for (const [over, code, setup] of cases) {
      const f = makeFixture();
      try {
        raw.set(`${RAW}LICENSE`, MIT);
        raw.delete(`${RAW}flagship.app.json`);
        raw.set(`${RAW}index.js`, ORIGINAL["index.js"]!);
        setup();
        const { body } = await ask(over, f);
        expect(body.status, code).toBe("refused");
        expect(codes(body), code).toEqual([code]);
        expect(body.reasons![0]!.fixable, code).toBe(false);
        expect(body.reasons![0]!.message.length, code).toBeGreaterThan(0);
        expect(await rows(f), code).toHaveLength(0);
      } finally {
        f.close();
      }
    }
  });

  it("refuses a repo on the do-not-adapt list", async () => {
    await call(post("/api/admin/adapter-blocklist", { repo: REPO }, { "x-admin-secret": ADMIN }));
    expect(codes((await ask()).body)).toEqual(["do-not-adapt"]);
  });

  it("refuses an adapter that edits more files than we can check", async () => {
    const adapter = {
      version: 1,
      source: { repo: REPO, base: BASE },
      patch: Array.from({ length: 801 }, (_, i) => ({
        path: `f${i}.js`,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
      })),
    };
    const file = JSON.stringify({ ...JSON.parse(MANIFEST), adapter });
    expect(codes((await ask({ file })).body)).toEqual(["too-large"]);
  });

  it("collects every fixable reason in one pass", async () => {
    const file = adapterFile({
      manifest: JSON.stringify({ ...JSON.parse(MANIFEST), version: "not-semver" }),
      adapted: { ...ADAPTED, ".env": "KEY=AKIAABCDEFGHIJKLMNOP\nHOST=home.harry.flagship.services\n" },
    });
    const { body } = await ask({ file });
    expect(body.status).toBe("refused");
    expect(codes(body)).toEqual(["rule", "adds-secret", "adds-server-address"]);
    expect(body.reasons!.every((r) => r.fixable)).toBe(true);
    expect(body.reasons![0]!.message).toMatch(/version/);
    expect(body.reasons![1]!.message).toMatch(/AWS access key/);
    // The box's own address is never echoed back.
    expect(JSON.stringify(body)).not.toContain("home.harry");
  });

  it("stops at the first reason it can't fix, keeping the fixable ones found so far", async () => {
    raw.delete(`${RAW}LICENSE`);
    const file = adapterFile({ manifest: JSON.stringify({ ...JSON.parse(MANIFEST), version: "x" }) });
    const { body } = await ask({ file });
    expect(codes(body)).toEqual(["rule", "no-license"]);
    expect(body.reasons!.map((r) => r.fixable)).toEqual([true, false]);
  });

  it("doesn't fetch an unsafe path a rule already refused", async () => {
    const adapter = {
      version: 1,
      source: { repo: REPO, base: BASE },
      remove: ["../../etc/passwd"],
    };
    const file = JSON.stringify({ ...JSON.parse(MANIFEST), adapter });
    const { body } = await ask({ file });
    expect(codes(body)).toEqual(["rule"]);
    expect(fetchCalls.some((c) => c.url.includes("passwd") || c.url.includes(".."))).toBe(false);
  });

  it("reports a review refusal as a fixed category, never the model's words", async () => {
    const f = makeFixture({ ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" });
    try {
      anthropic = () => categoryVerdict(false, "sends data out of the server", { note: "SECRET MODEL TEXT" });
      let { body } = await ask({}, f);
      expect(body.reasons).toEqual([{ code: "review", message: "sends data out of the server", fixable: true }]);
      expect(JSON.stringify(body)).not.toContain("SECRET MODEL TEXT");
      anthropic = () => categoryVerdict(false, "something the model made up");
      ({ body } = await ask({}, f));
      expect(body.reasons).toEqual([{ code: "review", message: "other concern", fixable: true }]);
      anthropic = () => new Response("overloaded", { status: 529 });
      ({ body } = await ask({}, f));
      expect(codes(body)).toEqual(["review-unavailable"]);
      expect(body.reasons![0]!.fixable).toBe(false);
      anthropic = () => categoryVerdict(true, "none");
      ({ body } = await ask({}, f));
      expect(body.status).toBe("kept");
      expect((await rows(f))[0]!.review).toBe("rules+ai");
    } finally {
      f.close();
    }
  });

  it("asks for the fixed categories in the review schema", async () => {
    const f = makeFixture({ ADAPTER_REVIEW_ANTHROPIC_KEY: "sk-test" });
    try {
      anthropic = () => categoryVerdict(true, "none");
      await ask({}, f);
      const ai = fetchCalls.find((c) => c.url.includes("anthropic"))!;
      const schema = JSON.parse(ai.init!.body as string).output_config.format.schema;
      expect(schema.required).toEqual(["ok", "category"]);
      expect(schema.properties.category.enum).toEqual([...REVIEW_CATEGORIES, "none"]);
    } finally {
      f.close();
    }
  });

  it("allows six attempts per repo, commit and day, then refuses", async () => {
    const bad = adapterFile({ manifest: JSON.stringify({ ...JSON.parse(MANIFEST), version: "x" }) });
    for (let i = 0; i < MAX_ATTEMPTS_PER_DAY; i++) expect(codes((await ask({ file: bad })).body)).toEqual(["rule"]);
    const seventh = await ask({ file: adapterFile() });
    expect(seventh.body).toMatchObject({ status: "refused" });
    expect(codes(seventh.body)).toEqual(["too-many-attempts"]);
    expect(seventh.body.reasons![0]!.fixable).toBe(false);
    // Another commit has its own allowance; a plain submit doesn't count.
    await submit(submission());
    expect(await rows()).toHaveLength(1);
    const counts = await fx.db.prepare("SELECT repo, base, count FROM adapter_attempts").bind().all<Record<string, unknown>>();
    expect(counts.results).toEqual([{ repo: REPO, base: BASE, count: 7 }]);
  });

  it("doesn't count attempts that fail the host check", async () => {
    for (let i = 0; i < 8; i++) await ask({ repo: "https://example.com/a/b" });
    const counts = await fx.db.prepare("SELECT count(*) AS n FROM adapter_attempts").bind().first<{ n: number }>();
    expect(counts!.n).toBe(0);
  });

  it("refuses an identical file once it has been retired", async () => {
    const file = adapterFile();
    await ask({ file });
    await fx.db.prepare("UPDATE repo_adapters SET published_day = '2026-10-01', retired_day = '2026-10-05', retired_reason = 'reports'").bind().run();
    const { body } = await ask({ file });
    expect(body.reasons).toEqual([
      { code: "retired", message: "This exact adaptation was retired after problem reports; a new one is welcome.", fixable: false },
    ]);
    expect((await rows())[0]!.pending_confirmations).toBe(1);
    // A new adaptation of the same repo is welcome.
    expect((await ask({ file: adapterFile({ adapted: { ...ADAPTED, "src/flagship.js": "export const port = 8080;\n" } }) })).body.status).toBe("kept");
  });
});

// ---- complaints -------------------------------------------------------------

describe("POST /api/adapters/complain", () => {
  async function publishOne(): Promise<string> {
    const file = adapterFile();
    await submit(submission({ file }));
    await fx.db.prepare("UPDATE repo_adapters SET published_day = '2026-10-01', r2_key = NULL").bind().run();
    return sha256(file);
  }
  const complain = (body: unknown) => call(post("/api/adapters/complain", body));
  const complaints = async () =>
    (await fx.db.prepare("SELECT file_sha256, stage, detail, day FROM adapter_complaints ORDER BY id").bind().all<Record<string, unknown>>()).results;

  it("400s on a malformed complaint", async () => {
    const file = "a".repeat(64);
    for (const body of [
      "nope",
      { file, stage: "build" },
      { repo: REPO, file: "A".repeat(64), stage: "build" },
      { repo: REPO, file: "abc", stage: "build" },
      { repo: REPO, file, stage: "crash" },
      { repo: REPO, file, stage: "build", detail: "it broke" },
      { repo: REPO, file, stage: "start", detail: "" },
      { repo: REPO, file, stage: "report", detail: 7 },
      { repo: REPO, file, stage: "report", detail: "x".repeat(2001) },
    ]) {
      expect((await complain(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(fx.pending).toHaveLength(0);
  });

  it("keeps a complaint about a published adapter of that repo, day only, and answers 202 either way", async () => {
    const file = await publishOne();
    for (const body of [
      { repo: REPO, file, stage: "build" },
      { repo: "https://github.com/me/notes.git", file, stage: "start" },
      { repo: REPO, file, stage: "report", detail: "x".repeat(2000) },
      { repo: REPO, file, stage: "report", detail: "" },
      { repo: "https://github.com/me/other", file, stage: "build" },
      { repo: REPO, file: "b".repeat(64), stage: "build" },
    ]) {
      const res = await complain(body);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe(ACCEPTED);
    }
    await Promise.all(fx.pending.splice(0));
    const kept = await complaints();
    expect(kept.map((c) => [c.stage, c.detail === null ? null : (c.detail as string).length])).toEqual([
      ["build", null],
      ["start", null],
      ["report", 2000],
      ["report", null],
    ]);
    expect(kept.every((c) => c.file_sha256 === file && /^\d{4}-\d{2}-\d{2}$/.test(c.day as string))).toBe(true);
    const cols = await fx.db.prepare("SELECT * FROM adapter_complaints LIMIT 1").bind().first<Record<string, unknown>>();
    expect(Object.keys(cols!).sort()).toEqual(["counted", "day", "detail", "file_sha256", "id", "reviewed", "stage"]);
  });

  it("drops a complaint about a pending or retired adapter", async () => {
    const file = adapterFile();
    await submit(submission({ file }));
    const sha = await sha256(file);
    await complain({ repo: REPO, file: sha, stage: "build" });
    await fx.db.prepare("UPDATE repo_adapters SET published_day = '2026-10-01', retired_day = '2026-10-02'").bind().run();
    await complain({ repo: REPO, file: sha, stage: "start" });
    await Promise.all(fx.pending.splice(0));
    expect(await complaints()).toEqual([]);
  });
});

// ---- insights ---------------------------------------------------------------

describe("GET /api/admin/adapter-insights", () => {
  it("is admin-gated and lists the newest 20", async () => {
    expect((await call(new Request(`${ORIGIN}/api/admin/adapter-insights`))).status).toBe(401);
    for (let i = 1; i <= 22; i++) {
      await fx.db
        .prepare("INSERT INTO adapter_insights (day, json) VALUES (?, ?)")
        .bind(`2026-${String(Math.ceil(i / 2)).padStart(2, "0")}-0${(i % 2) + 1}`, JSON.stringify({ patterns: [], harness_suggestions: [], n: i }))
        .run();
    }
    const res = await call(new Request(`${ORIGIN}/api/admin/adapter-insights`, { headers: { "x-admin-secret": ADMIN } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insights: Array<{ day: string; insight: { n: number } }> };
    expect(body.insights).toHaveLength(20);
    expect(body.insights[0]!.day).toBe("2026-11-02");
    expect(body.insights.map((i) => i.day)).toEqual([...body.insights.map((i) => i.day)].sort().reverse());
    expect((await call(post("/api/admin/adapter-insights", {}, { "x-admin-secret": ADMIN }))).status).toBe(405);
  });
});

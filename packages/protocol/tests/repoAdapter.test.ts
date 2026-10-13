import { describe, expect, it } from "vitest";
import {
  applyHunks,
  applyRepoAdapter,
  buildAdapterFile,
  deriveRepoAdapter,
  diffHunks,
  isEmptyAdapter,
  normalizeRepoUrl,
  repoAdapterProblems,
  splitAdapterFile,
  type RepoAdapter,
} from "../src/repoAdapter.js";

const BASE = "a".repeat(40);
const SRC = { repo: "https://github.com/me/notes", base: BASE };
const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { image: "x", port: 8080 },
});

function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe("repo adapters", () => {
  it("normalizes repo addresses to one spelling", () => {
    expect(normalizeRepoUrl("https://GitHub.com/me/Notes.git/")).toBe("https://github.com/me/Notes");
    expect(normalizeRepoUrl("git@github.com:me/notes.git")).toBe("https://github.com/me/notes");
    expect(normalizeRepoUrl("https://gitlab.com/group/sub/app")).toBe("https://gitlab.com/group/sub/app");
    expect(normalizeRepoUrl("https://user:pw@github.com/me/notes")).toBeNull();
    expect(normalizeRepoUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeRepoUrl("https://github.com/me")).toBeNull();
    expect(normalizeRepoUrl("https://github.com/me/../x")).toBeNull();
  });

  it("derive then apply gives back exactly the adapted tree", () => {
    const original = {
      "index.js": "const port = 3000;\napp.listen(port);\n",
      "README.md": "# Notes\n",
      "old.txt": "gone\n",
      "flagship.app.json": "{}",
    };
    const adapted = {
      "index.js": "const port = process.env.PORT;\napp.listen(port);\n",
      "README.md": "# Notes\n",
      Dockerfile: "FROM node:20-alpine\nEXPOSE 8080\n",
      "flagship.app.json": MANIFEST,
    };
    const adapter = deriveRepoAdapter(original, adapted, SRC);
    expect(Object.keys(adapter.add ?? {})).toEqual(["Dockerfile"]);
    expect(adapter.patch?.map((p) => p.path)).toEqual(["index.js"]);
    expect(adapter.remove).toEqual(["old.txt"]);
    const r = applyRepoAdapter(original, adapter, MANIFEST);
    expect(r).toEqual({ ok: true, files: adapted, fuzzy: false });
  });

  it("round-trips through the single file, readable line by line", () => {
    const adapter = deriveRepoAdapter({ a: "1\n2\n" }, { a: "1\n3\n", b: "new\n" }, SRC);
    const text = buildAdapterFile(MANIFEST, adapter);
    expect(text).toContain('"new",');
    const back = splitAdapterFile(text);
    expect(back).toEqual({ ok: true, manifestJson: MANIFEST, adapter });
    expect(splitAdapterFile(MANIFEST)).toEqual({ ok: true, manifestJson: MANIFEST, adapter: null });
  });

  it("still applies when the author has moved code around since", () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const adapted = base.replace("line 20", "line 20 (flagship)");
    const hunks = diffHunks(base, adapted);
    const later = ["// a new header", "// another", base].join("\n").replace("line 5", "line five");
    const r = applyHunks(later, hunks);
    expect(r?.content).toContain("line 20 (flagship)");
    expect(r?.content).toContain("line five");
    expect(r?.fuzzy).toBe(true);
  });

  it("reports the files whose edits no longer fit", () => {
    const adapter = deriveRepoAdapter({ a: "x\ny\nz\n" }, { a: "x\nY\nz\n" }, SRC);
    const r = applyRepoAdapter({ a: "totally\ndifferent\n" }, adapter, MANIFEST);
    expect(r).toEqual({ ok: false, failed: ["a"] });
  });

  it("matches random edits exactly, many times over", () => {
    const next = rand(7);
    for (let round = 0; round < 200; round++) {
      const n = Math.floor(next() * 60);
      const a = Array.from({ length: n }, () => `l${Math.floor(next() * 8)}`);
      const b = a.filter(() => next() > 0.2).flatMap((l) => (next() > 0.85 ? [l, `n${Math.floor(next() * 8)}`] : [l]));
      const before = a.join("\n");
      const after = b.join("\n");
      const r = applyHunks(before, diffHunks(before, after));
      expect(r?.content).toBe(after);
    }
  });

  it("an empty adapter changes nothing but the manifest", () => {
    expect(isEmptyAdapter(deriveRepoAdapter({ a: "1" }, { a: "1", "flagship.app.json": MANIFEST }, SRC))).toBe(true);
  });

  it("flags unsafe paths, secrets and a bad manifest", () => {
    const bad: RepoAdapter = {
      version: 1,
      source: { repo: "https://github.com/me/notes", base: "short" },
      add: { "../escape": ["x"], ".env": ["OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456"] },
      patch: [{ path: "flagship.app.json", hunks: [] }],
    };
    const problems = repoAdapterProblems(bad, "{}");
    expect(problems.join("\n")).toMatch(/full commit hash/);
    expect(problems.join("\n")).toMatch(/unsafe path: \.\.\/escape/);
    expect(problems.join("\n")).toMatch(/API key/);
    expect(problems.join("\n")).toMatch(/manifest:/);
    expect(problems.join("\n")).toMatch(/can't be added, edited or removed/);
    const good = deriveRepoAdapter({ a: "1\n" }, { a: "2\n" }, SRC);
    expect(repoAdapterProblems(good, MANIFEST)).toEqual([]);
  });

  it("never carries a build file: the box writes the build", () => {
    const adds = deriveRepoAdapter({ "a.js": "1\n" }, { "a.js": "1\n", Dockerfile: "FROM evil\n", ".dockerignore": "x\n" }, SRC);
    const p = repoAdapterProblems(adds, MANIFEST).join("\n");
    expect(p).toMatch(/can't add or change Dockerfile/);
    expect(p).toMatch(/can't add or change \.dockerignore/);
    const edits = deriveRepoAdapter({ Containerfile: "FROM a\n" }, { Containerfile: "FROM b\n" }, SRC);
    expect(repoAdapterProblems(edits, MANIFEST).join()).toMatch(/can't add or change Containerfile/);
    // Removing the repo's own, or a nested file that merely has the name, is fine.
    expect(repoAdapterProblems(deriveRepoAdapter({ Dockerfile: "x\n" }, {}, SRC), MANIFEST)).toEqual([]);
    expect(repoAdapterProblems(deriveRepoAdapter({}, { "docs/Dockerfile": "x\n" }, SRC), MANIFEST)).toEqual([]);
  });

  it("counts only secrets the adaptation brings in, not ones the public repo already has", () => {
    const key = "AKIAABCDEFGHIJKLMNOP";
    const moved = deriveRepoAdapter({ "a.js": `const k = "${key}";\n` }, { "b.js": `const k = "${key}";\n` }, SRC);
    expect(repoAdapterProblems(moved, MANIFEST, { publicText: [`const k = "${key}";\n`] })).toEqual([]);
    expect(repoAdapterProblems(moved, MANIFEST).join()).toMatch(/adds what looks like an AWS access key/);
    const added = deriveRepoAdapter({ "a.js": "x\n" }, { "a.js": `x\nconst k = "AKIAZZZZZZZZZZZZZZZZ";\n` }, SRC);
    expect(repoAdapterProblems(added, MANIFEST, { publicText: [`const k = "${key}";`] }).join()).toMatch(/AWS access key/);
    expect(repoAdapterProblems(added, MANIFEST, { skipSecrets: true })).toEqual([]);
  });

  it("rejects a malformed adapter section", () => {
    expect(splitAdapterFile(JSON.stringify({ adapter: { version: 2 } }))).toMatchObject({ ok: false });
    expect(splitAdapterFile(JSON.stringify({ adapter: { version: 1, source: { repo: "r", base: BASE }, patch: [{ path: "a", hunks: [{ lines: ["?x"] }] }] } }))).toMatchObject({ ok: false, reason: "adapter: malformed hunk" });
  });
});

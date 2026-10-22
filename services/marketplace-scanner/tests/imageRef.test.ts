import { describe, expect, it } from "vitest";
import {
  imageScanTargetFromManifest,
  resolveImageRef,
  resolveImageRefFromJson,
} from "../src/imageRef.js";

describe("resolveImageRef — manifest → OCI image ref", () => {
  it("extracts runtime.image from a well-formed manifest", () => {
    const manifest = {
      schema_version: 1,
      name: "habits",
      runtime: { image: "ghcr.io/alice/habits:0.1.0", port: 8080 },
    };
    expect(resolveImageRef(manifest)).toBe("ghcr.io/alice/habits:0.1.0");
  });

  it("accepts a registry with a port and a digest pin", () => {
    const ref =
      "registry.example.com:5000/team/app@sha256:" + "a".repeat(64);
    expect(resolveImageRef({ runtime: { image: ref } })).toBe(ref);
  });

  it("accepts a bare repo:tag and a docker-hub library image", () => {
    expect(resolveImageRef({ runtime: { image: "node:18" } })).toBe("node:18");
    expect(resolveImageRef({ runtime: { image: "postgres" } })).toBe("postgres");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveImageRef({ runtime: { image: "  node:18  " } })).toBe("node:18");
  });

  it.each([
    ["no runtime", { name: "x" }],
    ["runtime not an object", { runtime: "node:18" }],
    ["image missing", { runtime: { port: 8080 } }],
    ["image not a string", { runtime: { image: 123 } }],
    ["image empty", { runtime: { image: "   " } }],
    ["image with a space (unresolvable)", { runtime: { image: "ghcr.io/a b:1" } }],
    ["image with a shell metachar", { runtime: { image: "node:18;rm -rf" } }],
    ["null manifest", null],
    ["array manifest", ["node:18"]],
    ["string manifest", "node:18"],
  ])("resolves to null: %s", (_label, manifest) => {
    expect(resolveImageRef(manifest as unknown)).toBeNull();
  });

  it("rejects an over-long ref", () => {
    expect(resolveImageRef({ runtime: { image: "a".repeat(600) } })).toBeNull();
  });
});

describe("resolveImageRefFromJson — the scan-queue string form", () => {
  it("parses a JSON string and resolves the ref", () => {
    const json = JSON.stringify({ runtime: { image: "ghcr.io/bob/svc:2" } });
    expect(resolveImageRefFromJson(json)).toBe("ghcr.io/bob/svc:2");
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["undefined", undefined],
    ["null", null],
    ["non-JSON", "{not json"],
    ["JSON without runtime.image", JSON.stringify({ name: "x" })],
  ])("resolves to null: %s", (_label, input) => {
    expect(resolveImageRefFromJson(input as string | null | undefined)).toBeNull();
  });
});

describe("imageScanTargetFromManifest — docker:// discriminator", () => {
  it("prefixes a resolvable ref with docker://", () => {
    expect(
      imageScanTargetFromManifest({ runtime: { image: "node:18" } }),
    ).toBe("docker://node:18");
  });
  it("returns null when unresolvable", () => {
    expect(imageScanTargetFromManifest({ name: "x" })).toBeNull();
  });
});

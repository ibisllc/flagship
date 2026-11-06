// Replays test-vectors/voici-page-remove/ (tools/voici-page-remove-vectors.ts) and checks the file is fresh.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test-vectors", "voici-page-remove", "vectors.json"), "utf8"));
const h = (s: string) => P.hexToBytes(s);

describe("voici page removal", () => {
  it("canonical bytes and signatures match the vectors", () => {
    expect(new TextDecoder().decode(P.canonicalVoiciPageRemove(V.fields))).toBe(V.canonical);
    expect(V.canonical).toBe(`flagship/voici-page-remove/v1|alice|${"ab".repeat(16)}|4|${V.t0}`);
    expect(P.signVoiciPageRemove({ ...V.fields, signerKind: "admin-root" }, h(V.keys.adminRootSeed))).toEqual(V.signed);
    expect(P.signVoiciPageRemove({ ...V.fields, signerKind: "irk" }, h(V.keys.irkSeed))).toEqual(V.signedIrk);
    expect(Object.keys(V.signed)).toEqual(["kind", "version", "username", "pageId", "seq", "issuedAt", "signerKind", "signerPub", "signature"]);
  });

  it("every check answers as the vectors say", () => {
    for (const c of V.cases) {
      const r = P.checkVoiciPageRemove(c.remove, c.ctx);
      expect(r.ok ? "ok" : r.code, c.name).toBe(c.expected);
    }
  });

  it("parses JSON text and refuses junk", () => {
    expect(P.parseVoiciPageRemove(JSON.stringify(V.signed))).toEqual(V.signed);
    expect(P.parseVoiciPageRemove("{")).toBeNull();
    expect(P.parseVoiciPageRemove(null)).toBeNull();
    expect(P.parseVoiciPageRemove([V.signed])).toBeNull();
    expect(() => P.canonicalVoiciPageRemove({ ...V.fields, pageId: "AB".repeat(16) })).toThrow();
  });

  it("the vectors file is fresh", () => {
    execFileSync("npx", ["tsx", "tools/voici-page-remove-vectors.ts", "--check"], { cwd: join(import.meta.dirname, "..", "..", ".."), stdio: "pipe" });
  }, 120_000);
});

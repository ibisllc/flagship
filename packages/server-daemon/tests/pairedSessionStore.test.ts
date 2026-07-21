/**
 * Tests for the file-backed PairedSessionStore. Covers:
 *   - load reads what a previous instance wrote
 *   - check() honors Authorization: Flagship-Session <token>
 *   - add() rejects too-short tokens
 *   - remove() drops the entry from disk
 *   - corrupted on-disk JSON is treated as empty (don't fail boot)
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FilePairedSessionStore,
  defaultPairedSessionPath,
} from "../src/pairedSessionStore.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-paired-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FilePairedSessionStore", () => {
  it("starts empty when the file doesn't exist", async () => {
    const s = new FilePairedSessionStore(defaultPairedSessionPath(dir));
    await s.load();
    expect(s.list()).toEqual([]);
  });

  it("add + persist + load round-trips", async () => {
    const path = defaultPairedSessionPath(dir);
    const s1 = new FilePairedSessionStore(path);
    await s1.add("a".repeat(32), 1_700);
    const s2 = new FilePairedSessionStore(path);
    await s2.load();
    expect(s2.has("a".repeat(32))).toBe(true);
    expect(s2.list()[0]?.addedAt).toBe(1_700);
  });

  it("rejects short tokens", async () => {
    const s = new FilePairedSessionStore(defaultPairedSessionPath(dir));
    await expect(s.add("short")).rejects.toThrow(/too short/);
  });

  it("remove drops from disk", async () => {
    const path = defaultPairedSessionPath(dir);
    const s = new FilePairedSessionStore(path);
    const tok = "z".repeat(40);
    await s.add(tok);
    await s.remove(tok);
    expect(s.has(tok)).toBe(false);
    const buf = await readFile(path, "utf8");
    expect(JSON.parse(buf)).toEqual({});
  });

  it("check() returns 401 without auth", async () => {
    const s = new FilePairedSessionStore(defaultPairedSessionPath(dir));
    const r = s.check({
      method: "GET",
      path: "/api/phone/alerts",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(r?.status).toBe(401);
  });

  it("check() returns 401 for unknown token", async () => {
    const s = new FilePairedSessionStore(defaultPairedSessionPath(dir));
    const r = s.check({
      method: "GET",
      path: "/api/phone/alerts",
      headers: { authorization: "Flagship-Session bogus" },
      body: Buffer.alloc(0),
    });
    expect(r?.status).toBe(401);
  });

  it("check() returns null (success) for known token", async () => {
    const s = new FilePairedSessionStore(defaultPairedSessionPath(dir));
    const tok = "k".repeat(40);
    await s.add(tok, "ok");
    const r = s.check({
      method: "GET",
      path: "/api/phone/alerts",
      headers: { authorization: `Flagship-Session ${tok}` },
      body: Buffer.alloc(0),
    });
    expect(r).toBeNull();
  });

  it("malformed JSON on disk is treated as empty (boot doesn't fail)", async () => {
    const path = defaultPairedSessionPath(dir);
    await writeFile(path, "{not json}");
    const s = new FilePairedSessionStore(path);
    await s.load();
    expect(s.list()).toEqual([]);
  });
});

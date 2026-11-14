import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  appRestoreUndoCanonicalBytes,
  parseAppRestoreUndo,
  parseRestoreMergePlanLine,
  parseServerRestoreMerge,
  parseServerRestoreStage,
  restoreMergePlanLineString,
  restoreMergePlanSha256,
  serverRestoreMergeCanonicalBytes,
  serverRestoreStageCanonicalBytes,
  signAppRestoreUndo,
  signServerRestoreMerge,
  signServerRestoreStage,
  verifyAppRestoreUndo,
  verifyServerRestoreMerge,
  verifyServerRestoreStage,
  type RestoreMergePlanLine,
} from "../src/serverRestoreMerge.js";
import { ed } from "../src/edSync.js";

const V = JSON.parse(readFileSync(join(__dirname, "../test-vectors/server-restore-merge/vectors.json"), "utf8"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const seed = hexToBytes(V.adminSeedHex);
const admin = { privateKey: seed, publicKey: ed.getPublicKey(seed) };

describe("server-restore-merge vectors", () => {
  it("the stage order", () => {
    expect(bytesToHex(admin.publicKey)).toBe(V.adminPubHex);
    expect(text(serverRestoreStageCanonicalBytes(V.stage.order))).toBe(V.stage.canonical);
    expect(bytesToHex(signServerRestoreStage(V.stage.order, admin))).toBe(V.stage.signatureHex);
    expect(verifyServerRestoreStage(V.stage.order, hexToBytes(V.stage.signatureHex), admin.publicKey)).toBe(true);
    expect(verifyServerRestoreStage({ ...V.stage.order, source: "upload" }, hexToBytes(V.stage.signatureHex), admin.publicKey)).toBe(false);
    expect(parseServerRestoreStage(V.stage.order)).toEqual(V.stage.order);
    expect(parseServerRestoreStage({ ...V.stage.order, source: "usb" })).toBeNull();
  });

  it("the plan digest is order-free and names each line exactly", () => {
    const lines = V.plan.lines as RestoreMergePlanLine[];
    expect(restoreMergePlanSha256(lines)).toBe(V.plan.planSha256);
    expect(restoreMergePlanSha256([...lines].reverse())).toBe(V.plan.planSha256);
    expect([...lines].sort((a, b) => (a.archivedServiceId < b.archivedServiceId ? -1 : 1)).map(restoreMergePlanLineString)).toEqual(V.plan.sortedLines);
    for (const l of lines) expect(parseRestoreMergePlanLine(l)).toEqual(l);
    const changed = lines.map((l) => (l.action === "replace" && !l.sameApp ? { ...l, guardGen: 1 } : l));
    expect(restoreMergePlanSha256(changed)).not.toBe(V.plan.planSha256);
    expect(() => restoreMergePlanSha256([...lines, lines[0]!])).toThrow(/twice/);
    expect(() => restoreMergePlanSha256([])).toThrow();
    for (const { name, line } of V.invalidLines) {
      expect(() => restoreMergePlanLineString(line), name).toThrow();
      expect(parseRestoreMergePlanLine(line), name).toBeNull();
    }
  });

  it("the plan order", () => {
    expect(text(serverRestoreMergeCanonicalBytes(V.merge.order))).toBe(V.merge.canonical);
    expect(bytesToHex(signServerRestoreMerge(V.merge.order, admin))).toBe(V.merge.signatureHex);
    const sig = hexToBytes(V.merge.signatureHex);
    expect(verifyServerRestoreMerge(V.merge.order, sig, admin.publicKey)).toBe(true);
    expect(verifyServerRestoreMerge({ ...V.merge.order, planSha256: "00".repeat(32) }, sig, admin.publicKey)).toBe(false);
    expect(parseServerRestoreMerge(V.merge.order)).toEqual(V.merge.order);
    expect(parseServerRestoreMerge({ ...V.merge.order, expiresAt: V.merge.order.issuedAt + 24 * 3600_000 + 1 })).toBeNull();
    expect(parseServerRestoreMerge({ ...V.merge.order, expiresAt: V.merge.order.issuedAt })).toBeNull();
  });

  it("undo and discard", () => {
    for (const u of V.undo) {
      expect(text(appRestoreUndoCanonicalBytes(u.order))).toBe(u.canonical);
      expect(bytesToHex(signAppRestoreUndo(u.order, admin))).toBe(u.signatureHex);
      expect(verifyAppRestoreUndo(u.order, hexToBytes(u.signatureHex), admin.publicKey)).toBe(true);
      expect(parseAppRestoreUndo(u.order)).toEqual(u.order);
    }
    expect(verifyAppRestoreUndo(V.undo[1].order, hexToBytes(V.undo[0].signatureHex), admin.publicKey)).toBe(false);
    expect(parseAppRestoreUndo({ ...V.undo[0].order, action: "wipe" })).toBeNull();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileUpdateOutcomeStore,
  parseUpdateOutcome,
  refusalRecord,
  updateOutcomeActivity,
} from "../src/updateOutcome.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("refusalRecord", () => {
  it("keeps the refusals an owner can act on", () => {
    for (const reason of ["rejected", "wrong-domain", "stale", "from-commit-mismatch", "unendorsed", "apply-failed"] as const) {
      expect(refusalRecord({ applied: false, reason }, 7)).toEqual({ outcome: "refused", reason, at: 7 });
    }
  });

  it("ignores transient states, replays and successes", () => {
    for (const reason of ["no-order", "error", "pending-verify", "replayed-nonce"] as const) {
      expect(refusalRecord({ applied: false, reason }, 7)).toBeNull();
    }
    expect(refusalRecord({ applied: true, previousCommit: A, targetCommit: B }, 7)).toBeNull();
  });
});

describe("parseUpdateOutcome", () => {
  it("drops malformed fields instead of passing them to clients", () => {
    expect(
      parseUpdateOutcome({ outcome: "rolled-back", at: 1, targetCommit: B, previousCommit: "nope", reason: "made-up" }),
    ).toEqual({ outcome: "rolled-back", at: 1, targetCommit: B });
    expect(parseUpdateOutcome({ outcome: "exploded", at: 1 })).toBeNull();
    expect(parseUpdateOutcome({ outcome: "applied" })).toBeNull();
    expect(parseUpdateOutcome(null)).toBeNull();
  });
});

describe("fileUpdateOutcomeStore", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through the file and survives garbage", async () => {
    dir = mkdtempSync(join(tmpdir(), "update-outcome-"));
    const path = join(dir, "update-outcome.json");
    const store = fileUpdateOutcomeStore(path);
    expect(store.readSync()).toBeNull();
    const record = { outcome: "rolled-back" as const, at: 5, previousCommit: A, targetCommit: B, bootAttempts: 3 };
    await store.write(record);
    expect(store.readSync()).toEqual(record);
    writeFileSync(path, "{not json");
    expect(store.readSync()).toBeNull();
  });
});

describe("updateOutcomeActivity (docs/support/update-rollback.md §2)", () => {
  it("gives a rollback kept in recovery its own line, never 'was rolled back'", () => {
    const kept = updateOutcomeActivity({ outcome: "rolled-back", at: 1, targetCommit: B, previousCommit: A, rollbackRefused: true });
    expect(kept.kind).toBe("server.update.rolled-back");
    expect(kept.ok).toBe(false);
    expect(kept.detail).toBe(
      "The update to bbbbbbbb didn't start cleanly, and the version before it is too old to go back to safely. The server stays on bbbbbbbb in recovery mode until a fixed update arrives. Your apps and data are kept.",
    );
    expect(kept.detail).not.toMatch(/rolled back/);
    expect(updateOutcomeActivity({ outcome: "rolled-back", at: 1, targetCommit: B }).detail).toBe("The update to bbbbbbbb failed its boot check and was rolled back.");
    expect(updateOutcomeActivity({ outcome: "applied", at: 1, targetCommit: B })).toEqual({ kind: "server.update.applied", detail: "Updated to bbbbbbbb.", ok: true });
    expect(updateOutcomeActivity({ outcome: "refused", at: 1, reason: "not-endorsed" as never })).toMatchObject({ kind: "server.update.refused", ok: false });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeBytesAt } from "../../src/serverArchive/service.js";

describe("freeBytesAt", () => {
  it("measures the nearest existing parent when the backup folder was never made", async () => {
    const root = await mkdtemp(join(tmpdir(), "free-"));
    try {
      const n = await freeBytesAt(join(root, "archives", "deeper"));
      expect(n).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

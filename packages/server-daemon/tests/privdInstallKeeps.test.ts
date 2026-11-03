import { describe, expect, it } from "vitest";
import { ROOT_KEEPS } from "../src/privdInstall.js";

describe("the state files root keeps at the hand-over", () => {
  it("include every file the root updater reads as history", () => {
    for (const f of ["artifact-sequence", "artifact-current.json", "update-guard-starts", "update-intent.json", "runtime-manifest-accepted", "runtime-sequence"]) {
      expect(ROOT_KEEPS.has(f), f).toBe(true);
    }
  });
});

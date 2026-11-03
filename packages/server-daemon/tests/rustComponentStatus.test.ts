import { describe, expect, it } from "vitest";
import { parseRustComponentStatus, readRustComponentStatuses } from "../src/rustStack/componentStatus.js";

const SHA = "ab".repeat(32);
const line = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ component: "keyd", choice: "rust", reason: "running", sha256: SHA, pinned: SHA, switch: "on", at: 1_790_000_000, ...o });

describe("parseRustComponentStatus", () => {
  it("passes the selector's fields and nothing else", () => {
    const s = parseRustComponentStatus("keyd", JSON.stringify({ ...JSON.parse(line()), secret: "x", extra: 1 }));
    expect(s).toEqual({ component: "keyd", choice: "rust", reason: "running", sha256: SHA, pinned: SHA, switch: "on", at: 1_790_000_000 });
  });
  it("reads a TS fallback with no binary hash", () => {
    expect(parseRustComponentStatus("keyd", line({ choice: "ts", reason: "failed-to-start", sha256: "" }))?.choice).toBe("ts");
  });
  it("refuses anything malformed, another component's file, and never throws", () => {
    for (const bad of [
      null,
      "",
      "{",
      "[]",
      line({ component: "broker" }),
      line({ choice: "go" }),
      line({ reason: "Pinned!" }),
      line({ sha256: "zz" }),
      line({ pinned: 5 }),
      line({ switch: "maybe" }),
      line({ at: -1 }),
      line({ at: 1.5 }),
      "x".repeat(5000),
    ]) {
      expect(parseRustComponentStatus("keyd", bad as string | null)).toBeNull();
    }
  });
});

describe("readRustComponentStatuses", () => {
  it("reads each component's file; a missing one is null", async () => {
    const files: Record<string, string> = { "/r/keyd.status": line(), "/r/core.status": line({ component: "core", choice: "ts", reason: "switched-off", sha256: "", switch: "off" }) };
    const got = await readRustComponentStatuses(async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    }, "/r");
    expect(got.keyd?.choice).toBe("rust");
    expect(got.core?.reason).toBe("switched-off");
    expect(got.broker).toBeNull();
    expect(got.access).toBeNull();
  });
});

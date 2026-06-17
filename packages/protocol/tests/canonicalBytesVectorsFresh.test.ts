// Freshness gate: the checked-in test-vectors/canonical-bytes.json MUST be
// exactly what tools/test-vectors.ts produces today. Without this, someone
// could change a production canonical-byte encoder + the generator, forget to
// re-run it, and ship a stale fixture that all four language tests then assert
// against — defeating the whole point. This runs inside `npx vitest run`, and
// CI also runs `npx tsx tools/test-vectors.ts --check` as a belt-and-braces
// step. If this fails: `npx tsx tools/test-vectors.ts` and commit the result.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildFile } from "../../../tools/test-vectors.js";

const PATH = resolve(__dirname, "..", "..", "..", "test-vectors", "canonical-bytes.json");

describe("test-vectors/canonical-bytes.json freshness", () => {
  it("is byte-identical to tools/test-vectors.ts output", () => {
    expect(existsSync(PATH)).toBe(true);
    const onDisk = readFileSync(PATH, "utf8");
    const generated = buildFile().json;
    // Compare as strings so the failure diff is readable; if it differs the
    // fixture is stale → regenerate it.
    expect(onDisk).toBe(generated);
  });
});

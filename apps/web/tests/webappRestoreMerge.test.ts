import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module
import { appRestoreUndoBytes, restoreMergePlanLine, restoreMergePlanSha256, serverRestoreMergeBytes, serverRestoreStageBytes } from "../public/webapp/lib/restoreMerge.js";

const V = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/server-restore-merge/vectors.json", import.meta.url), "utf8"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("webapp restore-into-server orders", () => {
  it("builds the shared vectors' canonical bytes", () => {
    expect(text(serverRestoreStageBytes(V.stage.order))).toBe(V.stage.canonical);
    expect(restoreMergePlanSha256(V.plan.lines)).toBe(V.plan.planSha256);
    expect(text(serverRestoreMergeBytes(V.merge.order))).toBe(V.merge.canonical);
    for (const u of V.undo) expect(text(appRestoreUndoBytes(u.order))).toBe(u.canonical);
  });

  it("refuses every line the box refuses", () => {
    for (const { name, line } of V.invalidLines) expect(() => restoreMergePlanLine(line), name).toThrow();
  });
});

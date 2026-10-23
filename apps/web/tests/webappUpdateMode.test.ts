import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module
import { UPDATE_MODE_COPY, fetchUpdateMode, renderUpdateMode, setUpdateMode } from "../public/webapp/lib/updateMode.js";

const data = { mode: "manual", modes: ["manual", "staged", "auto", "frozen"], stagedHoldDays: 7 };

describe("webapp update mode", () => {
  it("offers every mode with the current one chosen, manual first", () => {
    const html = renderUpdateMode(data);
    expect(html.indexOf('value="manual"')).toBeLessThan(html.indexOf('value="staged"'));
    expect(html).toMatch(/value="manual" checked/);
    expect(html).not.toMatch(/value="auto" checked/);
    expect(html).toContain(UPDATE_MODE_COPY.staged.label);
  });
  it("shows nothing for a box without the setting, and ignores a mode it has no words for", () => {
    expect(renderUpdateMode(null)).toBe("");
    expect(renderUpdateMode({ mode: "manual", modes: ["manual", "weekly"] })).not.toContain("weekly");
  });
  it("asks the box to change the mode, and reads a 404 as not applicable", async () => {
    let sent: { path: string; body: string } | null = null;
    await setUpdateMode("alice--chess", "staged", async (path: string, init: { body: string }) => { sent = { path, body: init.body }; return { ok: true }; });
    expect(sent!.path).toBe("/api/screens/services/alice--chess/update-mode");
    expect(JSON.parse(sent!.body)).toEqual({ mode: "staged" });
    expect(await fetchUpdateMode("x", async () => { throw Object.assign(new Error("nf"), { status: 404 }); })).toBeNull();
  });
});

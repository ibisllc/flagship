import { describe, expect, it } from "vitest";
import { linkMessage, refusalMessage } from "../public/webapp/lib/linkField.js";
import { VoiciNameError } from "../public/webapp/lib/voiciName.js";

const link = (over = {}) => ({ name: null, held: 0, limit: 5, changesLeft: 3, nextChangeAt: null, releasesAt: null, ...over });
const msg = (over = {}) =>
  linkMessage({ typed: "halloween", current: "k3j9a2", link: link(), check: null, admin: true, ...over } as any);

describe("link field messages", () => {
  it("is read-only for a device that is not an admin", () => {
    const m = msg({ admin: false });
    expect(m.text).toBe("Only an admin device can change this");
    expect(m.canSave).toBe(false);
  });
  it("says nothing while the field still shows the current link", () => {
    expect(msg({ typed: "k3j9a2" })).toMatchObject({ text: "", canSave: false });
  });
  it("checks the grammar before asking .com", () => {
    expect(msg({ typed: "ab" }).text).toBe("At least 4 characters");
    expect(msg({ typed: "a_b_c_d" }).text).toBe("Letters, numbers and hyphens only");
  });
  it("offers Save only for an available name", () => {
    expect(msg({ check: { status: "available" } })).toMatchObject({ tone: "ok", canSave: true });
    expect(msg({ check: { status: "taken" } })).toMatchObject({ text: "Taken", canSave: false });
    expect(msg({ check: { status: "reserved" } }).text).toBe("Reserved");
    expect(msg({ check: { status: "error" } }).text).toBe("Couldn't check halloween. Try again.");
  });
  it("hands a dibs name to the domain proof", () => {
    expect(msg({ check: { status: "dibs", domain: "halloween.com" } })).toMatchObject({
      text: "Reserved for the owner of halloween.com",
      action: "dibs",
    });
  });
  it("offers to free one up when every name is in use, but not for a replace", () => {
    expect(msg({ link: link({ held: 5 }) })).toMatchObject({ text: "All 5 names in use", action: "free-up" });
    expect(msg({ link: link({ held: 5, name: "mine-now" }), check: { status: "available" } }).canSave).toBe(true);
  });
  it("shows the next change when the service has used its changes", () => {
    const m = msg({ link: link({ changesLeft: 0, nextChangeAt: Date.UTC(2026, 10, 1) }) });
    expect(m.text).toMatch(/^Next change /);
    expect(m.canSave).toBe(false);
  });
  it("turns each refusal into one short line", () => {
    const e = (code: string, data = {}) => new VoiciNameError(409, { code, ...data });
    expect(refusalMessage(e("taken"), "x")).toBe("Taken");
    expect(refusalMessage(e("rate-limited"), "x")).toBe("Too many changes today");
    expect(refusalMessage(e("name-limit", { limit: 25 }), "x")).toBe("All 25 names in use");
  });
});

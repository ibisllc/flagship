// The USB installer's disk stop (B2 #9): test-vectors/install-disk-stop.json, the file iOS and Android read too.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { failureDetail, parseDiskStop, renderSetupStopped } from "../public/webapp/lib/provisionProgress.js";

const V = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "..", "test-vectors", "install-disk-stop.json"), "utf8")) as {
  stops: Array<{ detail: string; kind: string | null; count?: string; sizes?: string; pin?: string }>;
};
const ADVICE = "Make the installer again with the same recipe and fill in Disk to install on with one of the disks the computer listed on its screen, then start the computer from it.";

describe("install disk stop vectors", () => {
  for (const v of V.stops) {
    it(`${v.kind ?? "not a stop"}: ${v.detail.slice(0, 50)}`, () => {
      const stop = parseDiskStop(v.detail);
      if (v.kind === null) {
        expect(stop).toBeNull();
        expect(failureDetail(v.detail)).not.toContain(ADVICE);
        expect(renderSetupStopped({ serial: "S", step: v.detail })).toContain("Cancel this order");
        return;
      }
      expect(stop).toEqual({
        kind: v.kind,
        ...(v.count !== undefined ? { count: v.count } : {}),
        ...(v.sizes !== undefined ? { sizes: v.sizes } : {}),
        ...(v.pin !== undefined ? { pin: v.pin } : {}),
      });
      const text = failureDetail(v.detail);
      expect(text.endsWith(` ${ADVICE}`)).toBe(true);
      expect(text).not.toContain("This machine");
      if (v.count) expect(text).toContain(`${v.count} disks`);
      if (v.sizes) expect(text).toContain(`(${v.sizes})`);
      if (v.pin) expect(text).toContain(`(${v.pin})`);
      const html = renderSetupStopped({ serial: "S", step: v.detail });
      expect(html).toContain("This server didn&#39;t finish installing.");
      expect(html).not.toContain("Cancel this order to free the name");
    });
  }

  it("escapes a pin it shows", () => {
    const html = renderSetupStopped({ serial: "S", step: "The disk this installer was made for (<b>x</b>) is not in this machine. Nothing was erased." });
    expect(html).not.toContain("<b>");
  });
});

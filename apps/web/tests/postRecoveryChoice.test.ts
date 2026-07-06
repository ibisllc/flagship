// Pure model for the webapp post-recovery device-disposition choice
// (L4 parity with iOS PostRecoveryChoiceScreen). Pins the copy + the
// enabled-state rules so the three blast-radii read identically to iOS
// and Wipe & restart stays gated off in v1.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadLib() {
  const path = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "postRecoveryChoice.js",
  );
  return import(pathToFileURL(path).href);
}

describe("postRecoveryChoice — choice set + default", () => {
  it("offers keep-both / replace-lost / wipe-restart in order, default keep-both", async () => {
    const m = await loadLib();
    expect(m.RECOVERY_CHOICES).toEqual(["keep-both", "replace-lost", "wipe-restart"]);
    expect(m.DEFAULT_RECOVERY_CHOICE).toBe("keep-both");
  });
});

describe("postRecoveryChoice — copy is verbatim from iOS", () => {
  it("titles match PostRecoveryChoiceScreen.titleFor", async () => {
    const m = await loadLib();
    expect(m.choiceTitle("keep-both")).toBe("Keep my other devices working");
    expect(m.choiceTitle("replace-lost")).toBe("Replace a device I lost");
    expect(m.choiceTitle("wipe-restart")).toBe("Wipe & restart");
  });

  it("subtitles spell out the blast radius and the irreversibility", async () => {
    const m = await loadLib();
    expect(m.choiceSubtitle("keep-both")).toMatch(/Default\./);
    expect(m.choiceSubtitle("keep-both")).toMatch(/stay logged in/);
    expect(m.choiceSubtitle("replace-lost")).toMatch(/Rotates your account's identity/);
    expect(m.choiceSubtitle("replace-lost")).toMatch(/Cannot be undone/);
    expect(m.choiceSubtitle("wipe-restart")).toMatch(/recovery passkey/);
    expect(m.choiceSubtitle("wipe-restart")).toMatch(/Cannot be undone/);
  });
});

describe("postRecoveryChoice — warning level + continue label", () => {
  it("escalates the warning glyph: keep-both none, replace warn, wipe danger", async () => {
    const m = await loadLib();
    expect(m.choiceWarning("keep-both")).toBeNull();
    expect(m.choiceWarning("replace-lost")).toBe("warn");
    expect(m.choiceWarning("wipe-restart")).toBe("danger");
  });

  it("Continue label reflects what the selection will do", async () => {
    const m = await loadLib();
    expect(m.continueLabel("keep-both")).toBe("Continue");
    expect(m.continueLabel("replace-lost")).toBe("Replace device");
    expect(m.continueLabel("wipe-restart")).toBe("Wipe & restart");
  });
});

describe("postRecoveryChoice — wipe is gated off in v1", () => {
  it("keep-both / replace-lost are always enabled", async () => {
    const m = await loadLib();
    expect(m.isChoiceEnabled("keep-both")).toBe(true);
    expect(m.isChoiceEnabled("replace-lost")).toBe(true);
    expect(m.isChoiceEnabled("keep-both", { wipeAndRestartEnabled: false })).toBe(true);
  });

  it("wipe-restart is disabled unless wipeAndRestartEnabled is set", async () => {
    const m = await loadLib();
    expect(m.isChoiceEnabled("wipe-restart")).toBe(false);
    expect(m.isChoiceEnabled("wipe-restart", { wipeAndRestartEnabled: false })).toBe(false);
    expect(m.isChoiceEnabled("wipe-restart", { wipeAndRestartEnabled: true })).toBe(true);
  });
});

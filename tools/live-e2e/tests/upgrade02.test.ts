import { describe, expect, it } from "vitest";
import { BRANCH_REF_REFUSAL, parseLsRemote, podView, productAtLeast } from "../lib/upgrade02.js";
import * as builder from "@flagship/builder";
import { preseedFor } from "../lib/isoBox.js";

describe("F9 lane helpers", () => {
  it("compares product versions numerically", () => {
    expect(productAtLeast({ product: "0.3" }, "0.3")).toBe(true);
    expect(productAtLeast({ product: "0.2" }, "0.3")).toBe(false);
    expect(productAtLeast({ product: "0.10" }, "0.9")).toBe(true);
    expect(productAtLeast({ product: "1" }, "0.3")).toBe(true);
    expect(productAtLeast({ product: "0.3-beta" }, "0.3")).toBe(false);
    expect(productAtLeast(null, "0.3")).toBe(false);
  });

  it("reads main's commit from ls-remote", () => {
    const sha = "a".repeat(40);
    expect(parseLsRemote(`${"b".repeat(40)}\trefs/heads/gym\n${sha}\trefs/heads/main\n`)).toBe(sha);
    expect(parseLsRemote("garbage")).toBeNull();
  });

  it("reads a /pods row", () => {
    expect(podView(undefined)).toEqual({ registered: false, heartbeat: false, updateRequired: null, certificate: false });
    expect(podView({ identityPubKey: "ab", lastReported: 1, updateRequired: { reason: "box-too-old", certificateExpiresAt: null }, currentCert: null })).toEqual({
      registered: true,
      heartbeat: true,
      updateRequired: "box-too-old",
      certificate: false,
    });
    expect(podView({ identityPubKey: "ab", lastReported: 1, updateRequired: null, currentCert: { notAfter: 1 } }).updateRequired).toBeNull();
  });

  it("the 0.3 engine refuses a 0.2 app's recipe (installerGitRef \"main\") unless the installer names the commit", async () => {
    // Structurally valid recipe; the engine does not verify signatures (the native caller does).
    const hex = (n: number, len: number) => n.toString(16).padStart(2, "0").repeat(len);
    const recipe = JSON.stringify({
      version: 2,
      serverDomain: "home.ab.gym.flagship.services",
      username: "ab",
      serverName: "home",
      phoneDelegatedPubKey: hex(1, 32),
      registrationUrl: "https://gym.flagshipserver.com/api/server/register",
      authCode: {
        version: 1,
        serial: hex(2, 16),
        username: "ab",
        serverName: "home",
        serverDomain: "home.ab.gym.flagship.services",
        delegatedPubKey: hex(1, 32),
        userPubKey: hex(3, 32),
        issuedAt: 1,
        expiresAt: 2,
      },
      authCodeUserSignature: hex(4, 64),
      installerGitRef: "main",
      rckPubKey: hex(5, 32),
      blobSignatureHex: hex(6, 64),
    });
    // This checkout's builder: the lanes use the gym worktree's, which CI does not have.
    await expect(preseedFor(recipe, {}, builder)).rejects.toThrow(BRANCH_REF_REFUSAL);
    await expect(preseedFor(recipe, { installerGitRef: "c".repeat(40) }, builder)).resolves.toBeTypeOf("string");
  });
});

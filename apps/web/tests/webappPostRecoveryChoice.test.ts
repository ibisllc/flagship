// L4 — the webapp post-recovery device-disposition choice, end to end:
//   - runKeepBoth brings the recovered device in WITHOUT rotation (no
//     re-pair POST), the new branch that gives the webapp parity with
//     iOS PostRecoveryChoiceScreen's default.
//   - loginRealAccount honours an injected `chooseDisposition`: keep-both
//     → runKeepBoth, replace-lost → the unchanged takeover, and the path
//     stays byte-identical when no chooser is injected.
//   - the static view + index.html surface ship the screen + wiring.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function loadLib() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "loginTakeover.js");
  return import(pathToFileURL(path).href);
}

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

function singleResolution(username = "harry", withRecovery = true) {
  return {
    username,
    exists: true,
    kind: "single",
    recovery: withRecovery
      ? { present: true, hasFetchGate: true, credentialId: "abc123" }
      : { present: false, hasFetchGate: false },
    totpEnrolled: false,
    graceModel: "3d",
  };
}

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeTakeoverDeps(overrides: Record<string, any> = {}) {
  const calls: Record<string, any> = { profiles: [] };
  const seed = new Uint8Array(32).fill(7);
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, completesAt: 1000 }));
  const deps = {
    recoverFromCloud: vi.fn(async (_u: string) => seed),
    bootstrapFromExistingSeed: vi.fn(async (pass: string, s: Uint8Array) => {
      calls.localPass = pass;
      calls.wrappedSeed = s;
    }),
    unlockSession: vi.fn(async (s: Uint8Array, u?: string) => { calls.unlock = { s, u }; }),
    deriveIrkFromSeed: vi.fn(async (_s: Uint8Array) => ({ publicKey: new Uint8Array(32).fill(0xa1) })),
    deriveIrkVersioned: vi.fn(async (_s: Uint8Array, v: number) => {
      calls.versioned = v;
      return { publicKey: new Uint8Array(32).fill(0xb2) };
    }),
    signWithIrkVersioned: vi.fn(async (_s: Uint8Array, v: number, bytes: Uint8Array) => {
      calls.signVersion = v;
      calls.signedBytes = bytes;
      return new Uint8Array(64).fill(0xcc);
    }),
    bytesToHex: toHex,
    makePassphrase: () => "fixed-local-passphrase",
    setUsername: vi.fn((u: string) => { calls.username = u; }),
    addProfile: vi.fn((p: object) => { calls.profiles.push(p); }),
    dispatchInitialView: vi.fn(async () => { calls.dispatched = true; }),
    fetch: fetchMock as any,
    now: () => 1234567,
    ...overrides,
  };
  return { deps, calls, seed, fetchMock };
}

describe("loginTakeover runKeepBoth — no-rotation bring-in", () => {
  it("unwraps, persists, labels the device, opens — and NEVER touches the network", async () => {
    const { runKeepBoth } = await loadLib();
    const { deps, calls, seed, fetchMock } = fakeTakeoverDeps();
    const out = await runKeepBoth(singleResolution("harry"), deps);

    // Credentialed unwrap + persist + unlock under the resolved username.
    expect(deps.recoverFromCloud).toHaveBeenCalledWith("harry");
    expect(calls.localPass).toBe("fixed-local-passphrase");
    expect(calls.unlock).toEqual({ s: seed, u: "harry" });
    expect(calls.username).toBe("harry");
    // NO rotation: the account IRK (v1) is derived, never a rotated key,
    // and nothing is signed.
    expect(deps.deriveIrkFromSeed).toHaveBeenCalledTimes(1);
    expect(deps.deriveIrkVersioned).not.toHaveBeenCalled();
    expect(deps.signWithIrkVersioned).not.toHaveBeenCalled();
    // The whole point: no re-pair POST, no grace clock.
    expect(fetchMock).not.toHaveBeenCalled();
    // Recorded on the local profile under the account IRK (v1).
    expect(calls.profiles).toHaveLength(1);
    expect(calls.profiles[0].cloudName).toBe("harry");
    expect(calls.profiles[0].cloudRootPubHex).toBe("a1".repeat(32));
    expect(calls.dispatched).toBe(true);
    expect(out).toMatchObject({ username: "harry", seed });
    expect(out.deviceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a no-recovery resolution before touching the passkey", async () => {
    const { runKeepBoth } = await loadLib();
    const { deps } = fakeTakeoverDeps();
    await expect(runKeepBoth(singleResolution("h", false), deps)).rejects.toThrow(/no cloud backup/);
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
  });

  it("rejects a malformed recovered seed", async () => {
    const { runKeepBoth } = await loadLib();
    const { deps } = fakeTakeoverDeps({ recoverFromCloud: vi.fn(async () => new Uint8Array(16)) });
    await expect(runKeepBoth(singleResolution("h"), deps)).rejects.toThrow(/malformed/);
  });
});

describe("loginTakeover loginRealAccount — chooseDisposition branch", () => {
  it("keep-both → runKeepBoth (no rotation), skips the grace explainer + re-pair", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const confirm = vi.fn(async () => true);
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm,
      prompt: vi.fn(),
      chooseDisposition: vi.fn(async () => "keep-both"),
      takeoverDeps: deps,
    });
    expect(out.outcome).toBe("keep-both");
    expect(out.keepBoth.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(confirm).not.toHaveBeenCalled(); // no takeover grace explainer
    expect(fetchMock).not.toHaveBeenCalled(); // no re-pair POST
  });

  it("replace-lost → falls through to the unchanged takeover", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => true),
      prompt: vi.fn(),
      chooseDisposition: vi.fn(async () => "replace-lost"),
      takeoverDeps: deps,
    });
    expect(out.outcome).toBe("takeover");
    expect(fetchMock).toHaveBeenCalledTimes(1); // re-pair initiated
  });

  it("backing out of the chooser cancels", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm: vi.fn(),
      prompt: vi.fn(),
      chooseDisposition: vi.fn(async () => null),
      takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
  });

  it("with NO chooser injected, recovery is the takeover it always was", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => true),
      prompt: vi.fn(),
      takeoverDeps: deps,
    });
    expect(out.outcome).toBe("takeover");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("webapp post-recovery-choice — static surface + wiring", () => {
  it("ships the choice view that resolves a disposition", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/post-recovery-choice.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-post-recovery-choice")');
    expect(r.body).toContain("enterPostRecoveryChoice");
    expect(r.body).toContain("initPostRecoveryChoiceView");
  });

  it("index.html declares the choice section + continue/back controls", async () => {
    const app = buildServer();
    const html = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('id="view-post-recovery-choice"');
    expect(html.body).toContain('id="post-recovery-choice-options"');
    expect(html.body).toContain('id="post-recovery-choice-continue"');
  });

  it("bootstrap injects chooseDisposition into the recovery login", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/bootstrap.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("chooseDisposition");
    expect(r.body).toContain("post-recovery-choice.js");
    expect(r.body).toContain('outcome === "keep-both"');
  });
});

// Phase 3 — real-account login state machine (single/multi + recovery TOTP).
//
// Pins the webapp side of the credentialed JOIN once the preflight has
// resolved a REAL account (docs/login-and-account-redesign.md, "The
// unified login decision tree" + "The admin label & the no-lockout
// guarantee" + "Recovery TOTP"):
//   - recovery.present == false → a clean inline STATE (not a 404), with
//     distinct single vs multi copy.
//   - single (recovery.present) → cloud-recovery unwrap → 7-day-grace
//     TAKEOVER → INITIATE re-pair (POST /api/users/:u/re-pair) → this
//     device labelled "admin".
//   - multi (recovery.present) → unwrap + a recovery TOTP (6-digit) OR a
//     recovery code, REQUIRED before the re-pair, passed as `totpProof`
//     → 24h-grace TAKEOVER → "admin".
//   - The re-pair body: NEW IRK (rotated version) signs canonical bytes
//     over (username, newIrkPub, oldIrkPub, issuedAt); OLD IRK is the
//     registered (v1) key; totpProof rides BESIDE the signed envelope.
//
// Grace countdown/completion/push/quarantine are Phase 4 (not here); the
// flow only INITIATES the re-pair. Live PRF is out of scope —
// recoverFromCloud is injected (the Mock/popup sub-origin flow as today).

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadLib() {
  const path = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "loginTakeover.js",
  );
  return import(pathToFileURL(path).href);
}

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
    trustedDeviceCount: 1,
    graceModel: "7d",
  };
}

function multiResolution(username = "hilton", withRecovery = true) {
  return {
    username,
    exists: true,
    kind: "multi",
    recovery: withRecovery
      ? { present: true, hasFetchGate: true, credentialId: "def456" }
      : { present: false, hasFetchGate: false },
    totpEnrolled: true,
    trustedDeviceCount: 3,
    graceModel: "24h-totp",
  };
}

/** A fake injected takeover-deps bundle. Records every side effect; the
 *  fetch returns a happy re-pair-initiate body. */
function fakeTakeoverDeps(overrides: Record<string, any> = {}) {
  const calls: Record<string, any> = { profiles: [] };
  const seed = new Uint8Array(32).fill(7);
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse(200, {
      ok: true,
      completesAt: 1000,
      graceMs: 500,
      accountType: "single",
      totpRequired: false,
      quarantineMs: 42,
    }),
  );
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

describe("loginTakeover classifyRealAccount — real-account branch", () => {
  it("routes recovery.present == false → 'no-recovery' (single + multi)", async () => {
    const { classifyRealAccount } = await loadLib();
    expect(classifyRealAccount(singleResolution("h", false))).toBe("no-recovery");
    expect(classifyRealAccount(multiResolution("h", false))).toBe("no-recovery");
    expect(classifyRealAccount(null)).toBe("no-recovery");
    expect(classifyRealAccount(undefined)).toBe("no-recovery");
  });

  it("routes single (recovery.present) → 'single'", async () => {
    const { classifyRealAccount } = await loadLib();
    expect(classifyRealAccount(singleResolution())).toBe("single");
  });

  it("routes multi (recovery.present) → 'multi'", async () => {
    const { classifyRealAccount } = await loadLib();
    expect(classifyRealAccount(multiResolution())).toBe("multi");
  });
});

describe("loginTakeover noRecoveryState — inline STATE copy (not a 404)", () => {
  it("single → 'use a device that still has access'", async () => {
    const { noRecoveryState } = await loadLib();
    const s = noRecoveryState(singleResolution("h", false));
    expect(s.message).toBe(
      "No cloud backup on this account. Use a device that still has access.",
    );
  });

  it("multi → 'use another device, or one of your recovery codes'", async () => {
    const { noRecoveryState } = await loadLib();
    const s = noRecoveryState(multiResolution("h", false));
    expect(s.message).toBe("Use another device, or one of your recovery codes.");
  });
});

describe("loginTakeover parseRecoveryFactor — TOTP vs recovery code", () => {
  it("a 6-digit string is a TOTP proof", async () => {
    const { parseRecoveryFactor } = await loadLib();
    expect(parseRecoveryFactor("123456")).toEqual({ code: "123456", method: "totp" });
  });

  it("a non-6-digit non-empty string is a recovery code", async () => {
    const { parseRecoveryFactor } = await loadLib();
    expect(parseRecoveryFactor("ABCD-EFGH")).toEqual({ code: "ABCD-EFGH", method: "recovery" });
    expect(parseRecoveryFactor("1234567")).toEqual({ code: "1234567", method: "recovery" });
  });

  it("empty / whitespace / non-string → null", async () => {
    const { parseRecoveryFactor } = await loadLib();
    expect(parseRecoveryFactor("")).toBeNull();
    expect(parseRecoveryFactor("   ")).toBeNull();
    expect(parseRecoveryFactor(undefined as any)).toBeNull();
  });

  it("trims surrounding whitespace before classifying", async () => {
    const { parseRecoveryFactor } = await loadLib();
    expect(parseRecoveryFactor("  123456  ")).toEqual({ code: "123456", method: "totp" });
  });
});

describe("loginTakeover initiateRePair — J.3 envelope body", () => {
  it("POSTs the NEW-IRK-signed re-pair body to /api/users/:u/re-pair", async () => {
    const { initiateRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, completesAt: 9 }));
    const out = await initiateRePair({
      username: "harry",
      newIrkPubHex: "bb".repeat(32),
      oldIrkPubHex: "aa".repeat(32),
      signHex: "cc".repeat(64),
      issuedAt: 1000,
      fetch: fetchMock as any,
    });
    expect(out).toEqual({ ok: true, completesAt: 9 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://flagshipserver.com/api/users/harry/re-pair");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.request.username).toBe("harry");
    expect(body.request.newIrkPub).toBe("bb".repeat(32));
    expect(body.request.oldIrkPub).toBe("aa".repeat(32));
    expect(body.request.issuedAt).toBe(1000);
    expect(body.signature).toBe("cc".repeat(64));
    // No totpProof on a single (none supplied).
    expect(body.totpProof).toBeUndefined();
  });

  it("rides totpProof BESIDE the signed envelope (multi)", async () => {
    const { initiateRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    await initiateRePair({
      username: "hilton",
      newIrkPubHex: "bb".repeat(32),
      oldIrkPubHex: "aa".repeat(32),
      signHex: "cc".repeat(64),
      totpProof: { code: "123456", method: "totp" },
      fetch: fetchMock as any,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.totpProof).toEqual({ code: "123456", method: "totp" });
  });

  it("throws on a non-2xx (e.g. 401 multi missing totpProof)", async () => {
    const { initiateRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, "totpProof required"));
    await expect(
      initiateRePair({
        username: "hilton",
        newIrkPubHex: "bb".repeat(32),
        oldIrkPubHex: "aa".repeat(32),
        signHex: "cc".repeat(64),
        fetch: fetchMock as any,
      }),
    ).rejects.toThrow(/re-pair initiate failed \(401\)/);
  });
});

describe("loginTakeover runTakeover — single (3-day grace)", () => {
  it("unwraps, persists, INITIATES re-pair, labels admin, opens", async () => {
    const { runTakeover, TAKEOVER_IRK_VERSION, ADMIN_LABEL, TAG_RE_PAIR_INITIATE } = await loadLib();
    const { deps, calls, seed, fetchMock } = fakeTakeoverDeps();
    const out = await runTakeover(singleResolution("harry"), deps);

    // 1 — credentialed unwrap.
    expect(deps.recoverFromCloud).toHaveBeenCalledWith("harry");
    // 2 — persisted under a generated local passphrase + unlocked.
    expect(calls.localPass).toBe("fixed-local-passphrase");
    expect(calls.unlock).toEqual({ s: seed, u: "harry" });
    expect(calls.username).toBe("harry");
    // 3 — NEW IRK (rotated) signs; OLD IRK is v1 (registered).
    expect(deps.deriveIrkFromSeed).toHaveBeenCalledTimes(1);
    expect(calls.versioned).toBe(TAKEOVER_IRK_VERSION);
    expect(calls.signVersion).toBe(TAKEOVER_IRK_VERSION);
    const signedStr = new TextDecoder().decode(calls.signedBytes);
    const parts = signedStr.split("|");
    expect(parts[0]).toBe(TAG_RE_PAIR_INITIATE);
    expect(parts[1]).toBe("harry");
    expect(parts[2]).toBe("b2".repeat(32)); // newIrkPub (rotated)
    expect(parts[3]).toBe("a1".repeat(32)); // oldIrkPub (registered v1)
    // 4 — re-pair initiated with the right body (single → no totpProof).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://flagshipserver.com/api/users/harry/re-pair");
    const body = JSON.parse(init.body);
    expect(body.request.newIrkPub).toBe("b2".repeat(32));
    expect(body.request.oldIrkPub).toBe("a1".repeat(32));
    expect(body.totpProof).toBeUndefined();
    // 5 — admin label on the local profile.
    expect(calls.profiles).toHaveLength(1);
    expect(calls.profiles[0].cloudName).toBe("harry");
    expect(calls.profiles[0].deviceLabel).toBe(ADMIN_LABEL);
    // 6 — opened.
    expect(calls.dispatched).toBe(true);
    expect(out.username).toBe("harry");
    expect(out.deviceLabel).toBe(ADMIN_LABEL);
    expect(out.rePair.ok).toBe(true);
  });

  it("rejects a no-recovery resolution before touching the network", async () => {
    const { runTakeover } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    await expect(runTakeover(singleResolution("h", false), deps))
      .rejects.toThrow(/no cloud backup/);
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed recovered seed", async () => {
    const { runTakeover } = await loadLib();
    const { deps } = fakeTakeoverDeps({
      recoverFromCloud: vi.fn(async () => new Uint8Array(16)),
    });
    await expect(runTakeover(singleResolution("h"), deps)).rejects.toThrow(/malformed/);
  });
});

describe("loginTakeover runTakeover — multi (24h grace, TOTP required)", () => {
  it("passes the collected totpProof in the re-pair body", async () => {
    const { runTakeover } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps({
      totpProof: { code: "654321", method: "totp" },
    });
    await runTakeover(multiResolution("hilton"), deps);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.totpProof).toEqual({ code: "654321", method: "totp" });
  });

  it("REFUSES a multi takeover without a totpProof (no re-pair POST)", async () => {
    const { runTakeover } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps(); // no totpProof
    await expect(runTakeover(multiResolution("hilton"), deps))
      .rejects.toThrow(/requires a recovery TOTP or recovery code/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
  });
});

describe("loginTakeover loginRealAccount — full branch orchestration", () => {
  it("no-recovery → renders the STATE, no takeover, no confirm/prompt", async () => {
    const { loginRealAccount } = await loadLib();
    const showState = vi.fn();
    const confirm = vi.fn();
    const prompt = vi.fn();
    const { deps } = fakeTakeoverDeps();
    const out = await loginRealAccount(singleResolution("h", false), {
      showState,
      confirm,
      prompt,
      takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "no-recovery" });
    expect(showState).toHaveBeenCalledTimes(1);
    expect(showState.mock.calls[0]![0].message).toMatch(/still has access/);
    expect(confirm).not.toHaveBeenCalled();
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
  });

  it("single → confirm the 3-day grace → takeover (no factor prompt)", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const confirm = vi.fn(async () => true);
    const prompt = vi.fn();
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm,
      prompt,
      takeoverDeps: deps,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0].message).toMatch(/3-day grace/);
    expect(prompt).not.toHaveBeenCalled(); // single needs no second factor
    expect(out.outcome).toBe("takeover");
    expect(out.takeover.deviceLabel).toBe("admin");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("single → cancelling the grace explainer aborts (no takeover)", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => false),
      prompt: vi.fn(),
      takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "cancelled" });
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("multi → confirm → collect TOTP → takeover with totpProof", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const prompt = vi.fn(async () => "123456");
    const out = await loginRealAccount(multiResolution("hilton"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => true),
      prompt,
      takeoverDeps: deps,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("takeover");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.totpProof).toEqual({ code: "123456", method: "totp" });
  });

  it("multi → cancelling the TOTP prompt aborts BEFORE the re-pair POST", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const out = await loginRealAccount(multiResolution("hilton"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => true),
      prompt: vi.fn(async () => null), // user cancels the factor
      takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "cancelled" });
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("multi → a recovery code (non-6-digit) is accepted as method:'recovery'", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    await loginRealAccount(multiResolution("hilton"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => true),
      prompt: vi.fn(async () => "RECOV-CODE-001"),
      takeoverDeps: deps,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.totpProof).toEqual({ code: "RECOV-CODE-001", method: "recovery" });
  });
});

// ───────────────────────────────────────────────────────────────────
// #52 follow-up — credential on SINGLE-device initiate. The Worker now
// 401s a bare single-device initiate when the account has a second
// factor enrolled, carrying `credentialRequired`; the webapp prompts
// (same collector as multi) and retries once with the proof riding
// the body.
// ───────────────────────────────────────────────────────────────────

function credential401() {
  return jsonResponse(401, {
    error:
      "totpProof required for single-device recovery (a second factor is enrolled)",
    accountType: "single",
    credentialRequired: ["totp", "recovery-code"],
  });
}

describe("#52 — single-device credential-required initiate", () => {
  it("runTakeover: 401 credentialRequired → prompts requestSecondFactor → retries with the proof in the body", async () => {
    const { runTakeover } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(credential401())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          completesAt: 1000,
          graceMs: 500,
          accountType: "single",
          totpRequired: false,
        }),
      );
    const requestSecondFactor = vi.fn(async (methods: string[]) => {
      expect(methods).toEqual(["totp", "recovery-code"]);
      return { code: "123456", method: "totp" };
    });
    const out = await runTakeover(singleResolution("harry"), {
      ...deps,
      requestSecondFactor,
    });
    expect(requestSecondFactor).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First POST had no proof; the retry rides it BESIDE the envelope.
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(first.totpProof).toBeUndefined();
    const retry = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(retry.totpProof).toEqual({ code: "123456", method: "totp" });
    // Same signed envelope on both attempts (the proof is NOT in the
    // canonical bytes, so no re-sign is needed).
    expect(retry.request).toEqual(first.request);
    expect(retry.signature).toBe(first.signature);
    expect(out.deviceLabel).toBe("admin");
  });

  it("runTakeover: cancelling the on-demand prompt throws the tagged cancel (no retry POST)", async () => {
    const { runTakeover } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    fetchMock.mockReset().mockResolvedValueOnce(credential401());
    const requestSecondFactor = vi.fn(async () => null);
    await expect(
      runTakeover(singleResolution("harry"), { ...deps, requestSecondFactor }),
    ).rejects.toMatchObject({ code: "second-factor-cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("runTakeover: no collector injected → the 401 rethrows unchanged (back-compat)", async () => {
    const { runTakeover } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    fetchMock.mockReset().mockResolvedValueOnce(credential401());
    await expect(runTakeover(singleResolution("harry"), deps)).rejects.toThrow(
      /re-pair initiate failed \(401\)/,
    );
  });

  it("runTakeover: a bad proof on the retry surfaces the second 401 (no infinite loop)", async () => {
    const { runTakeover } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(credential401())
      .mockResolvedValueOnce(
        jsonResponse(401, { error: "invalid TOTP proof", remainingAttempts: 4 }),
      );
    const requestSecondFactor = vi.fn(async () => ({
      code: "000000",
      method: "totp" as const,
    }));
    await expect(
      runTakeover(singleResolution("harry"), { ...deps, requestSecondFactor }),
    ).rejects.toThrow(/invalid TOTP proof/);
    expect(requestSecondFactor).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loginRealAccount single: the cloud-required factor is collected via deps.prompt and retried", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(credential401())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          completesAt: 1000,
          graceMs: 500,
          accountType: "single",
          totpRequired: false,
        }),
      );
    const prompt = vi.fn(async () => "ABCD-EFGH-IJ");
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => true),
      prompt,
      takeoverDeps: deps,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("takeover");
    const retry = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(retry.totpProof).toEqual({ code: "ABCD-EFGH-IJ", method: "recovery" });
  });

  it("loginRealAccount single: cancelling the on-demand factor → outcome 'cancelled'", async () => {
    const { loginRealAccount } = await loadLib();
    const { deps, fetchMock } = fakeTakeoverDeps();
    fetchMock.mockReset().mockResolvedValueOnce(credential401());
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(),
      confirm: vi.fn(async () => true),
      prompt: vi.fn(async () => null),
      takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isCredentialRequiredError: detects 401+credentialRequired and 401+'totpProof' substring; rejects others", async () => {
    const { isCredentialRequiredError } = await loadLib();
    expect(
      isCredentialRequiredError({
        status: 401,
        body: { credentialRequired: ["totp"] },
      }),
    ).toBe(true);
    expect(
      isCredentialRequiredError({
        status: 401,
        body: { error: "totpProof required for multi-device recovery" },
      }),
    ).toBe(true);
    expect(
      isCredentialRequiredError({ status: 401, body: { error: "invalid TOTP proof" } }),
    ).toBe(false);
    expect(
      isCredentialRequiredError({ status: 403, body: { credentialRequired: ["totp"] } }),
    ).toBe(false);
    expect(isCredentialRequiredError(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// #52 follow-up — completion-window expiry surfaces as a clean state.
// ───────────────────────────────────────────────────────────────────

describe("#52 — completeRePair 410 (completion window expired)", () => {
  it("410 → outcome 'expired' with the server message", async () => {
    const { completeRePair } = await loadLib();
    const f = vi.fn(async () =>
      jsonResponse(410, {
        error: "re-pair completion window has expired; start a new recovery",
        completesAt: 1,
        completionDeadline: 2,
      }),
    );
    const out = await completeRePair({ username: "harry", fetch: f as any });
    expect(out.outcome).toBe("expired");
    expect(out.message).toMatch(/completion window has expired/);
  });

  it("finishTakeover on a 410 does NOT finalize or open the account", async () => {
    const { finishTakeover } = await loadLib();
    const f = vi.fn(async () => jsonResponse(410, { error: "expired" }));
    const finalizeV2Irk = vi.fn();
    const openAccount = vi.fn();
    const out = await finishTakeover(
      { username: "harry", rePair: { completesAt: 100 } },
      { fetch: f as any, now: () => 200, finalizeV2Irk, openAccount },
    );
    expect(out.outcome).toBe("expired");
    expect(finalizeV2Irk).not.toHaveBeenCalled();
    expect(openAccount).not.toHaveBeenCalled();
  });
});

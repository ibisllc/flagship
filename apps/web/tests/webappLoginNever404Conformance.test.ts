// Phase 5 — never-404 login audit + decision-matrix conformance (webapp).
//
// The login / join space is access-control EVALUATION, not a web fetch
// (docs/login-and-account-redesign.md, "The principle"): a raw 404 is a
// category error. Phases 0–4 built each branch; this file is the
// HARDENING conformance that pins the WHOLE decision matrix as one
// contract and proves the never-404 invariant holds for every absent
// server state across the integrated login/onboarding/join/recovery/
// add-device flows.
//
// It exercises the SHIPPED JS (lib/accountResolve.js, lib/loginTakeover.js,
// lib/openAccount.js, lib/crossDevicePairing.js, lib/recovery.js) — the
// same modules bootstrap.js / views/join.js / views/add-device.js wire —
// so a regression that re-introduces a raw 404 in any login network call
// fails here.
//
// The AccountResolution decision matrix asserted (the doc's "unified
// login decision tree"):
//   demo                       → activateDemoAccount (NO passkey/popup)
//   unknown                    → clean STATE (not a 404)
//   single (recovery present)  → takeover, 3-day grace
//   multi  (recovery present)  → takeover, 24h grace, TOTP-gated
//   recovery.present == false  → clean STATE, single vs multi copy
//   quarantined (added device) → countdown + disabled-disconnect
//
// Mirrors the matrix the iOS / Android conformance pins, per the lockstep
// rule + the Mock-matches-Worker-wire invariant.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* ---------- module loaders (exercise the shipped JS) ---------- */

function libPath(name: string) {
  return pathToFileURL(
    resolve(__dirname, "..", "public", "webapp", "lib", name),
  ).href;
}
const loadResolve = () => import(libPath("accountResolve.js"));
const loadTakeover = () => import(libPath("loginTakeover.js"));
const loadOpenAccount = () => import(libPath("openAccount.js"));
const loadPairing = () => import(libPath("crossDevicePairing.js"));

function jsonResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/* ---------- the canonical AccountResolution fixtures (wire-mirror) ----------
 * These MUST match packages/control-plane/src/accountResolve.ts's projection
 * EXACTLY (graceModel derived from kind; recovery absent → present:false). */

function demoResolution(username = "demoalice") {
  return {
    username,
    exists: true,
    kind: "demo" as const,
    recovery: { present: false, hasFetchGate: false },
    totpEnrolled: false,
    demoServer: { fqdn: `home.${username}.flagship.services`, status: "up", ttlIdleMinutes: 30 },
    graceModel: "instant" as const,
  };
}
function unknownResolution(username = "ghost") {
  return {
    username,
    exists: false,
    kind: "unknown" as const,
    recovery: { present: false, hasFetchGate: false },
    totpEnrolled: false,
    graceModel: "none" as const,
  };
}
function singleResolution(username = "harry", withRecovery = true) {
  return {
    username,
    exists: true,
    kind: "single" as const,
    recovery: withRecovery
      ? { present: true, hasFetchGate: true, credentialId: "abc123" }
      : { present: false, hasFetchGate: false },
    totpEnrolled: false,
    graceModel: "3d" as const,
  };
}
function multiResolution(username = "hilton", withRecovery = true) {
  return {
    username,
    exists: true,
    kind: "multi" as const,
    recovery: withRecovery
      ? { present: true, hasFetchGate: true, credentialId: "def456" }
      : { present: false, hasFetchGate: false },
    totpEnrolled: true,
    graceModel: "24h-totp" as const,
  };
}

/* A complete injected takeover-deps bundle (records every side effect;
 * the fetch returns a happy re-pair-initiate body). Mirror of the bundle
 * in webappLoginTakeover.test.ts so the conformance runs the same wiring
 * bootstrap.js hands runTakeover. */
function fakeTakeoverDeps(overrides: Record<string, any> = {}) {
  const calls: Record<string, any> = { profiles: [] };
  const seed = new Uint8Array(32).fill(7);
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse(200, {
      ok: true, completesAt: 1000, graceMs: 500,
      accountType: "single", totpRequired: false, quarantineMs: 42,
    }),
  );
  const deps = {
    recoverFromCloud: vi.fn(async (_u: string) => seed),
    setActiveKeystoreProfile: vi.fn(),
    bootstrapFromExistingSeed: vi.fn(async () => {}),
    unlockSession: vi.fn(async () => {}),
    deriveIrkFromSeed: vi.fn(async () => ({ publicKey: new Uint8Array(32).fill(0xa1) })),
    deriveIrkVersioned: vi.fn(async () => ({ publicKey: new Uint8Array(32).fill(0xb2) })),
    signWithIrkVersioned: vi.fn(async () => new Uint8Array(64).fill(0xcc)),
    bytesToHex: toHex,
    makePassphrase: () => "fixed-local-passphrase",
    setUsername: vi.fn(),
    addProfile: vi.fn((p: object) => calls.profiles.push(p)),
    dispatchInitialView: vi.fn(async () => {}),
    fetch: fetchMock as any,
    now: () => 1234567,
    ...overrides,
  };
  return { deps, calls, seed, fetchMock };
}

/* ════════════════════════════════════════════════════════════════════
 * 1. THE DECISION MATRIX — classify the full AccountResolution set.
 *    One source of truth, asserted as a matrix (the doc's switch(kind)).
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — AccountResolution decision matrix", () => {
  it("classifyResolution maps every kind to its login branch", async () => {
    const { classifyResolution } = await loadResolve();
    const matrix: Array<[unknown, string]> = [
      [demoResolution(), "demo"],
      [unknownResolution(), "unknown"],
      [singleResolution(), "recover"],
      [multiResolution(), "recover"],
      // defensive: a "real" kind with exists:false is still a miss.
      [{ ...singleResolution(), exists: false }, "unknown"],
      [null, "unknown"],
      [undefined, "unknown"],
    ];
    for (const [res, expected] of matrix) {
      expect(classifyResolution(res as any), JSON.stringify(res)).toBe(expected);
    }
  });

  it("classifyRealAccount splits the credentialed branch by recovery + kind", async () => {
    const { classifyRealAccount } = await loadTakeover();
    const matrix: Array<[unknown, string]> = [
      [singleResolution("h", false), "no-recovery"],
      [multiResolution("h", false), "no-recovery"],
      [singleResolution("h", true), "single"],
      [multiResolution("h", true), "multi"],
      [null, "no-recovery"],
    ];
    for (const [res, expected] of matrix) {
      expect(classifyRealAccount(res as any), JSON.stringify(res)).toBe(expected);
    }
  });

  it("graceModel in each fixture matches the kind-derived server projection", async () => {
    // The webapp NEVER re-derives the matrix — it renders graceModel as
    // the server sent it. Pin that the fixtures stay wire-faithful so a
    // drift in the doc's "instant|3d|24h-totp|none" mapping is caught.
    expect(demoResolution().graceModel).toBe("instant");
    expect(unknownResolution().graceModel).toBe("none");
    expect(singleResolution().graceModel).toBe("3d");
    expect(multiResolution().graceModel).toBe("24h-totp");
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 2. NEVER-404 — the preflight: a miss is kind:"unknown" in a 200 body,
 *    and a real non-2xx is a transport STATE, never a "missing account".
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — preflight never treats a miss as a 404", () => {
  it("a 200 unknown body is a STATE the client renders, not an error", async () => {
    const { resolveAccount, classifyResolution } = await loadResolve();
    const r = await resolveAccount("ghost", {
      fetch: vi.fn().mockResolvedValue(jsonResponse(200, unknownResolution("ghost"))) as any,
    });
    expect(r.kind).toBe("unknown");
    expect(r.exists).toBe(false);
    // The branch the entry view takes is the clean "no such account" STATE.
    expect(classifyResolution(r)).toBe("unknown");
  });

  it("a HARD 404 from the directory throws (transport fault) — distinct from a miss", async () => {
    // The endpoint is 200-always, so a literal 404 here is a deploy/route
    // fault, NOT a missing account. It surfaces as a thrown transport
    // error the entry view toasts ("couldn't reach the directory"), which
    // is itself a clean state — it is never silently swallowed nor shown
    // as "no such account".
    const { resolveAccount } = await loadResolve();
    await expect(
      resolveAccount("x", { fetch: vi.fn().mockResolvedValue(new Response("", { status: 404 })) as any }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("429 / 5xx surface a transport STATE, never a missing-account verdict", async () => {
    const { resolveAccount } = await loadResolve();
    await expect(
      resolveAccount("x", {
        fetch: vi.fn().mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "9" } })) as any,
      }),
    ).rejects.toThrow(/9s/);
    await expect(
      resolveAccount("x", { fetch: vi.fn().mockResolvedValue(new Response("", { status: 503 })) as any }),
    ).rejects.toThrow(/503/);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 3. demo → activate (NO passkey, NO popup, NO 404 anywhere).
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — demo branch activates with no credentials", () => {
  it("activateDemoAccount mints a fresh device + opens, with zero network credential calls", async () => {
    const { activateDemoAccount } = await loadResolve();
    const seed = new Uint8Array(32).fill(9);
    const fetchMock = vi.fn(); // demo must NOT touch the network for any credential.
    const deps = {
      bootstrapNewIdentity: vi.fn(async () => seed),
      unlockSession: vi.fn(async () => {}),
      addProfile: vi.fn(),
      dispatchInitialView: vi.fn(async () => {}),
      setUsername: vi.fn(),
      makePassphrase: () => "x".repeat(32),
      fetch: fetchMock as any,
    };
    const out = await activateDemoAccount(demoResolution("demoalice"), deps as any);
    expect(out.username).toBe("demoalice");
    expect(deps.bootstrapNewIdentity).toHaveBeenCalledTimes(1);
    expect(deps.unlockSession).toHaveBeenCalledWith(seed, "demoalice");
    expect(deps.dispatchInitialView).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 4. recovery.present == false → a clean STATE, single vs multi copy.
 *    This is the matrix node most prone to a 404 regression (it is the
 *    "no recovery record" the OLD naive-fetch clients 404'd on).
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — no-recovery renders a STATE, never a 404", () => {
  it("loginRealAccount(single, no-recovery) shows the state, runs NO network", async () => {
    const { loginRealAccount } = await loadTakeover();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const showState = vi.fn();
    const out = await loginRealAccount(singleResolution("harry", false), {
      showState, confirm: vi.fn(), prompt: vi.fn(), takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "no-recovery" });
    expect(showState).toHaveBeenCalledTimes(1);
    expect(showState.mock.calls[0]![0].message).toBe(
      "No cloud backup on this account. Use a device that still has access.",
    );
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loginRealAccount(multi, no-recovery) shows the recovery-codes state", async () => {
    const { loginRealAccount } = await loadTakeover();
    const { deps } = fakeTakeoverDeps();
    const showState = vi.fn();
    const out = await loginRealAccount(multiResolution("hilton", false), {
      showState, confirm: vi.fn(), prompt: vi.fn(), takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "no-recovery" });
    expect(showState.mock.calls[0]![0].message).toBe(
      "Use another device, or one of your recovery codes.",
    );
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 5. single → 3-day-grace takeover; multi → 24h-grace, TOTP-gated.
 *    Asserted as one matrix over the credentialed branch.
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — credentialed takeover matrix (single vs multi)", () => {
  it("single → 3-day grace, NO second-factor prompt, re-pair body has no totpProof", async () => {
    const { loginRealAccount } = await loadTakeover();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const confirm = vi.fn(async () => true);
    const prompt = vi.fn();
    const out = await loginRealAccount(singleResolution("harry"), {
      showState: vi.fn(), confirm, prompt, takeoverDeps: deps,
    });
    expect(confirm.mock.calls[0]![0].message).toMatch(/3-day grace/);
    expect(prompt).not.toHaveBeenCalled();
    expect(out.outcome).toBe("takeover");
    expect(out.takeover.deviceId).toMatch(/^[0-9a-f]{32}$/);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.totpProof).toBeUndefined();
  });

  it("multi → 24h grace, REQUIRES a recovery factor, re-pair body carries totpProof", async () => {
    const { loginRealAccount } = await loadTakeover();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const confirm = vi.fn(async () => true);
    const prompt = vi.fn(async () => "123456");
    const out = await loginRealAccount(multiResolution("hilton"), {
      showState: vi.fn(), confirm, prompt, takeoverDeps: deps,
    });
    expect(confirm.mock.calls[0]![0].message).toMatch(/24-hour grace/);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("takeover");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.totpProof).toEqual({ code: "123456", method: "totp" });
  });

  it("multi → cancelling the factor aborts BEFORE any re-pair network call", async () => {
    const { loginRealAccount } = await loadTakeover();
    const { deps, fetchMock } = fakeTakeoverDeps();
    const out = await loginRealAccount(multiResolution("hilton"), {
      showState: vi.fn(), confirm: vi.fn(async () => true), prompt: vi.fn(async () => null), takeoverDeps: deps,
    });
    expect(out).toEqual({ outcome: "cancelled" });
    expect(deps.recoverFromCloud).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 6. NEVER-404 — re-pair COMPLETE maps every absent server state to a
 *    tagged outcome (the UI renders a state), never a raw error.
 *    404 → already-completed, 403/409 → objected, 425 → too-early.
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — re-pair complete: every absent state is a tagged outcome", () => {
  const cases: Array<[number, unknown, string]> = [
    [200, { newIrkPub: "x" }, "completed"],
    [404, "", "already-completed"],          // no pending row == benign done
    [403, { error: "objected" }, "objected"],
    [409, { error: "claimed" }, "objected"],
    [425, { completesAt: 5, secondsRemaining: 3 }, "too-early"],
  ];
  it.each(cases)("status %i → outcome %s (never thrown)", async (status, body, expected) => {
    const { completeRePair } = await loadTakeover();
    const out = await completeRePair({
      username: "harry",
      fetch: vi.fn().mockResolvedValue(jsonResponse(status, body)) as any,
    });
    expect(out.outcome).toBe(expected);
  });

  it("a genuine 500 still throws (transport fault, not an absent state)", async () => {
    const { completeRePair } = await loadTakeover();
    await expect(
      completeRePair({ username: "harry", fetch: vi.fn().mockResolvedValue(jsonResponse(500, "boom")) as any }),
    ).rejects.toThrow(/re-pair complete failed \(500\)/);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 7. NEVER-404 — open-account claim: an already-claimed name is a 409
 *    the client treats as SUCCESS (idempotent), not a failure.
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — open-account claim treats 409 as success", () => {
  it("a 409 (name already bound to this IRK) returns alreadyClaimed:true, no throw", async () => {
    const { claimUsername } = await loadOpenAccount();
    const out = await claimUsername(
      "harry",
      new Uint8Array(32).fill(1),
      async () => new Uint8Array(64).fill(2),
      { fetch: vi.fn().mockResolvedValue(jsonResponse(409, "already claimed")) as any, bytesToHex: toHex },
    );
    expect(out).toEqual({ status: 409, alreadyClaimed: true });
  });

  it("a 200 is a fresh claim; a 4xx other than 409 throws", async () => {
    const { claimUsername } = await loadOpenAccount();
    const ok = await claimUsername(
      "harry", new Uint8Array(32), async () => new Uint8Array(64),
      { fetch: vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })) as any, bytesToHex: toHex },
    );
    expect(ok.alreadyClaimed).toBe(false);
    await expect(
      claimUsername("harry", new Uint8Array(32), async () => new Uint8Array(64),
        { fetch: vi.fn().mockResolvedValue(jsonResponse(400, "bad")) as any, bytesToHex: toHex }),
    ).rejects.toThrow(/claim failed \(400\)/);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 8. quarantined (cross-device add) → countdown view-model.
 *    The matrix's last node: a vouched device joins QUARANTINED; the
 *    incoming side surfaces a countdown, never a hard error.
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — quarantine countdown (added device)", () => {
  it("quarantineTimeline renders a live countdown while under review", async () => {
    const { quarantineTimeline } = await loadPairing();
    const now = 1_000_000;
    const t = quarantineTimeline({ quarantineUntil: now + 14 * 86_400_000 }, now);
    expect(t.quarantined).toBe(true);
    expect(t.remainingMs).toBe(14 * 86_400_000);
    expect(t.label).toMatch(/under review/);
    expect(t.label).toMatch(/can't manage other devices/);
  });

  it("an elapsed window flips to the cleared state (no error, no 404)", async () => {
    const { quarantineTimeline } = await loadPairing();
    const now = 1_000_000;
    const t = quarantineTimeline({ quarantineUntil: now - 1 }, now);
    expect(t.quarantined).toBe(false);
    expect(t.remainingMs).toBe(0);
    expect(t.label).toBe("This device's review window has elapsed.");
  });

  it("a missing quarantineUntil falls back cleanly (no throw)", async () => {
    const { quarantineTimeline } = await loadPairing();
    const t = quarantineTimeline({}, 1_000_000);
    expect(t.quarantined).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * 9. NEVER-404 — the cross-device admit network calls only throw on a
 *    GENUINE fault (post-SAS-verified pairing where the account is known
 *    to exist), and the join view renders that as an in-view error state,
 *    never an unhandled crash. We pin the function-level surface here.
 * ════════════════════════════════════════════════════════════════════ */

describe("Phase 5 conformance — cross-device admit faults surface cleanly", () => {
  it("fetchAccountIrkPubHex throws a readable error on a non-2xx (rendered as a join STATE)", async () => {
    const { fetchAccountIrkPubHex } = await loadPairing();
    await expect(
      fetchAccountIrkPubHex({
        username: "harry",
        fetch: vi.fn().mockResolvedValue(new Response("", { status: 404 })) as any,
      }),
    ).rejects.toThrow(/couldn't resolve account key \(404\)/);
  });

  it("postDeviceAdmit throws a readable error on a non-2xx (rendered as a join STATE)", async () => {
    const { postDeviceAdmit } = await loadPairing();
    await expect(
      postDeviceAdmit({
        username: "harry",
        admit: { username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1 },
        admitSigHex: "cc".repeat(64),
        request: {},
        signatureHex: "dd".repeat(64),
        fetch: vi.fn().mockResolvedValue(jsonResponse(409, "device exists")) as any,
      }),
    ).rejects.toThrow(/device admit failed \(409\)/);
  });
});

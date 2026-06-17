// Phase 4 — grace-period takeover completion + countdown (webapp).
//
// Phase 3 INITIATES the re-pair (runTakeover) and returns the grace
// result { completesAt, graceMs, accountType, totpRequired,
// quarantineMs }. Phase 4 takes that result and:
//   1. graceTimeline(rePair, now) → a countdown view-model with the
//      "This device takes over in N — your other devices are being
//      alerted" copy and a "Take over now" action that arms once
//      now >= completesAt (graceModel: 3d single / 24h-totp multi).
//   2. completeRePair() → POST /api/users/:u/re-pair/complete
//      (idempotent, no signature gate; body optional per W6). Tagged
//      outcomes so the UI renders states, never raw errors:
//        200 → completed   404 → already-completed
//        403/409 → objected   425 → too-early.
//   3. finishTakeover() → guards the deadline, completes, and on
//      success finalizes the v2 IRK locally + opens the account.
//
// Server contract: packages/control-plane/src/rePair.ts
// handleCompleteRePair (425 Too Early when grace hasn't elapsed; 409
// objected / IRK already moved; 404 no pending row).

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

const DAY = 24 * 60 * 60_000;

// Initiate results as the Phase-3 runTakeover returns them.
function singleRePair(completesAt = 7 * DAY) {
  return {
    ok: true,
    completesAt,
    graceMs: 7 * DAY,
    accountType: "single",
    totpRequired: false,
    quarantineMs: 14 * DAY,
  };
}

function multiRePair(completesAt = DAY) {
  return {
    ok: true,
    completesAt,
    graceMs: DAY,
    accountType: "multi",
    totpRequired: true,
    quarantineMs: 14 * DAY,
  };
}

describe("loginTakeover formatRemaining — countdown wording", () => {
  it("days+hours / hours+minutes / minutes+seconds / seconds", async () => {
    const { formatRemaining } = await loadLib();
    expect(formatRemaining(2 * DAY + 3 * 3_600_000)).toBe("2d 3h");
    expect(formatRemaining(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatRemaining(7 * 60_000 + 30_000)).toBe("7m 30s");
    expect(formatRemaining(45_000)).toBe("45s");
  });

  it("clamps negative / zero to 0s", async () => {
    const { formatRemaining } = await loadLib();
    expect(formatRemaining(-1_000_000)).toBe("0s");
    expect(formatRemaining(0)).toBe("0s");
  });
});

describe("loginTakeover graceTimeline — grace window per graceModel", () => {
  it("single (3d): mid-window → not ready, action disabled, alert copy", async () => {
    const { graceTimeline } = await loadLib();
    const completesAt = 3 * DAY; // measured from now=0
    const t = graceTimeline(singleRePair(completesAt), 0);
    expect(t.graceModel).toBe("3d");
    expect(t.ready).toBe(false);
    expect(t.actionEnabled).toBe(false);
    expect(t.remainingMs).toBe(3 * DAY);
    expect(t.label).toBe(
      "This device takes over in 3d 0h — your other devices are being alerted.",
    );
  });

  it("multi (24h-totp): mid-window → not ready, 24h graceModel copy", async () => {
    const { graceTimeline } = await loadLib();
    const t = graceTimeline(multiRePair(DAY), 0);
    expect(t.graceModel).toBe("24h-totp");
    expect(t.ready).toBe(false);
    expect(t.remainingMs).toBe(DAY);
    expect(t.label).toContain("your other devices are being alerted");
  });

  it("'Take over now' arms exactly once now >= completesAt", async () => {
    const { graceTimeline } = await loadLib();
    const completesAt = 1000;
    expect(graceTimeline(singleRePair(completesAt), 999).ready).toBe(false);
    const at = graceTimeline(singleRePair(completesAt), 1000);
    expect(at.ready).toBe(true);
    expect(at.actionEnabled).toBe(true);
    expect(at.remainingMs).toBe(0);
    expect(at.label).toBe("The grace period has elapsed — you can take over now.");
    expect(graceTimeline(singleRePair(completesAt), 5000).ready).toBe(true);
  });

  it("remainingMs is clamped at 0 past the deadline", async () => {
    const { graceTimeline } = await loadLib();
    expect(graceTimeline(singleRePair(1000), 9999).remainingMs).toBe(0);
  });
});

describe("loginTakeover completeRePair — outcomes by status", () => {
  it("200 → completed, POSTs an empty body to /re-pair/complete", async () => {
    const { completeRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, newIrkPub: "bb".repeat(32), swappedAt: 42, quarantineUntil: 99 }),
    );
    const out = await completeRePair({ username: "harry", fetch: fetchMock as any });
    expect(out.outcome).toBe("completed");
    expect((out as any).body.newIrkPub).toBe("bb".repeat(32));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://flagshipserver.com/api/users/harry/re-pair/complete");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({}); // no refreshedGrants
  });

  it("threads refreshedGrants (W6) into the body when supplied", async () => {
    const { completeRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const grants = [{ grantId: "g1" }];
    await completeRePair({ username: "harry", refreshedGrants: grants, fetch: fetchMock as any });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ refreshedGrants: grants });
  });

  it("404 → already-completed (swapped earlier / swept)", async () => {
    const { completeRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "no pending re-pair" }));
    const out = await completeRePair({ username: "harry", fetch: fetchMock as any });
    expect(out).toEqual({ outcome: "already-completed" });
  });

  it("409 → objected (carries the server message)", async () => {
    const { completeRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, { error: "re-pair was objected by the old IRK", objectedAt: 7 }),
    );
    const out = await completeRePair({ username: "harry", fetch: fetchMock as any });
    expect(out.outcome).toBe("objected");
    expect((out as any).status).toBe(409);
    expect((out as any).message).toBe("re-pair was objected by the old IRK");
  });

  it("403 → objected (forward-compat clean-surface)", async () => {
    const { completeRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { error: "forbidden" }));
    const out = await completeRePair({ username: "harry", fetch: fetchMock as any });
    expect(out.outcome).toBe("objected");
    expect((out as any).status).toBe(403);
  });

  it("425 → too-early (carries completesAt + secondsRemaining)", async () => {
    const { completeRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(425, { error: "grace window has not elapsed", completesAt: 5000, secondsRemaining: 12 }),
    );
    const out = await completeRePair({ username: "harry", fetch: fetchMock as any });
    expect(out).toEqual({ outcome: "too-early", completesAt: 5000, secondsRemaining: 12 });
  });

  it("throws on a genuine server fault (500)", async () => {
    const { completeRePair } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, "boom"));
    await expect(completeRePair({ username: "harry", fetch: fetchMock as any })).rejects.toThrow(
      /re-pair complete failed \(500\)/,
    );
  });

  it("requires a username", async () => {
    const { completeRePair } = await loadLib();
    await expect(completeRePair({ username: "" } as any)).rejects.toThrow(/missing username/);
  });
});

describe("loginTakeover finishTakeover — gate + finalize + open", () => {
  function takeoverObj(completesAt: number) {
    return { username: "harry", rePair: singleRePair(completesAt), deviceLabel: "admin" };
  }

  it("before the deadline → too-early, no POST, no finalize", async () => {
    const { finishTakeover } = await loadLib();
    const fetchMock = vi.fn();
    const finalizeV2Irk = vi.fn();
    const openAccount = vi.fn();
    const out = await finishTakeover(takeoverObj(10_000), {
      fetch: fetchMock as any,
      finalizeV2Irk,
      openAccount,
      now: () => 5_000,
    });
    expect(out.outcome).toBe("too-early");
    expect((out as any).secondsRemaining).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalizeV2Irk).not.toHaveBeenCalled();
    expect(openAccount).not.toHaveBeenCalled();
  });

  it("at/after the deadline → completes, finalizes v2 IRK, opens account", async () => {
    const { finishTakeover } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, newIrkPub: "bb" }));
    const finalizeV2Irk = vi.fn();
    const openAccount = vi.fn();
    const out = await finishTakeover(takeoverObj(1_000), {
      fetch: fetchMock as any,
      finalizeV2Irk,
      openAccount,
      now: () => 1_000,
    });
    expect(out.outcome).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(finalizeV2Irk).toHaveBeenCalledTimes(1);
    expect(openAccount).toHaveBeenCalledTimes(1);
  });

  it("404 already-completed → still finalizes + opens (idempotent done)", async () => {
    const { finishTakeover } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "no pending re-pair" }));
    const finalizeV2Irk = vi.fn();
    const openAccount = vi.fn();
    const out = await finishTakeover(takeoverObj(1_000), {
      fetch: fetchMock as any,
      finalizeV2Irk,
      openAccount,
      now: () => 2_000,
    });
    expect(out.outcome).toBe("already-completed");
    expect(finalizeV2Irk).toHaveBeenCalledTimes(1);
    expect(openAccount).toHaveBeenCalledTimes(1);
  });

  it("objected (409) → does NOT finalize or open", async () => {
    const { finishTakeover } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(409, { error: "objected" }));
    const finalizeV2Irk = vi.fn();
    const openAccount = vi.fn();
    const out = await finishTakeover(takeoverObj(1_000), {
      fetch: fetchMock as any,
      finalizeV2Irk,
      openAccount,
      now: () => 2_000,
    });
    expect(out.outcome).toBe("objected");
    expect(finalizeV2Irk).not.toHaveBeenCalled();
    expect(openAccount).not.toHaveBeenCalled();
  });

  it("server-raced 425 (deadline passed locally) → too-early, no finalize", async () => {
    const { finishTakeover } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(425, { error: "grace window has not elapsed", secondsRemaining: 3 }),
    );
    const finalizeV2Irk = vi.fn();
    const openAccount = vi.fn();
    const out = await finishTakeover(takeoverObj(1_000), {
      fetch: fetchMock as any,
      finalizeV2Irk,
      openAccount,
      now: () => 2_000, // local clock thinks ready; server disagrees
    });
    expect(out.outcome).toBe("too-early");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(finalizeV2Irk).not.toHaveBeenCalled();
  });

  it("requires a username on the takeover object", async () => {
    const { finishTakeover } = await loadLib();
    await expect(finishTakeover({ rePair: singleRePair() } as any)).rejects.toThrow(
      /missing username/,
    );
  });
});

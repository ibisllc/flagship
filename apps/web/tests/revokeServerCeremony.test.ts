// P13 — per-server kill-switch webapp ceremony.
//
// Pins:
//   - canonical-bytes shape byte-for-byte against @flagship/protocol's
//     `signRevocation` / `verifyRevocation` (the same envelope the
//     iOS / Android view-models ship).
//   - the POST shape (URL, headers, body keys + values).
//   - error mapping for non-2xx statuses (`.code` on the thrown error).
//   - reason-picker validation (the {lost,stolen,decommissioned}
//     vocabulary).
//   - the webapp's 3-second confirmation countdown (fake timers +
//     cancel-via-AbortSignal).

import { describe, expect, it, vi } from "vitest";
import {
  canonicalRevokeBytes,
  countdownConfirm,
  revokeServer,
  REVOCATION_REASONS,
  TAG_REVOKE,
} from "../public/webapp/lib/revokeServer.js";
import {
  signRevocation,
  verifyRevocation,
  type ServerRevocation,
} from "@flagship/protocol";
import { ed } from "@flagship/protocol";

const USER_ID = "harry";
const SERVER_DOMAIN = "home.harry.flagship.services";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("P13 — canonical-bytes shape", () => {
  it("uses the protocol's TAG_REVOKE", () => {
    expect(TAG_REVOKE).toBe("flagship/revoke/v1");
  });

  it("exposes the {lost,stolen,decommissioned} reason vocabulary", () => {
    expect(REVOCATION_REASONS).toEqual(["lost", "stolen", "decommissioned"]);
  });

  it("composes the exact byte sequence with all 5 pieces joined by |", () => {
    const got = new TextDecoder().decode(
      canonicalRevokeBytes({
        userId: USER_ID,
        revokedServerId: SERVER_DOMAIN,
        reason: "stolen",
        issuedAt: 1700000000000,
      }),
    );
    expect(got).toBe(
      "flagship/revoke/v1|harry|home.harry.flagship.services|stolen|1700000000000",
    );
  });

  it("round-trips through @flagship/protocol signRevocation/verifyRevocation", () => {
    // The Worker's verifyRevocation must accept what the webapp signs
    // when both compute their canonical bytes from the same inputs.
    const priv = new Uint8Array(32);
    for (let i = 0; i < 32; i++) priv[i] = (i * 7 + 1) & 0xff;
    const pub = ed.getPublicKey(priv);
    const claim: ServerRevocation = {
      userId: USER_ID,
      revokedServerId: SERVER_DOMAIN,
      reason: "lost",
      issuedAt: 1700000000000,
    };
    const sig = signRevocation(claim, { privateKey: priv, publicKey: pub });

    // The webapp's canonical bytes MUST match the protocol's.
    const webappBytes = canonicalRevokeBytes({
      userId: claim.userId,
      revokedServerId: claim.revokedServerId,
      reason: claim.reason,
      issuedAt: claim.issuedAt,
    });
    expect(ed.verify(sig, webappBytes, pub)).toBe(true);
    expect(verifyRevocation(claim, sig, pub)).toBe(true);
  });
});

describe("P13 — POST shape (happy path)", () => {
  it("POSTs to /api/server-registry/revoke with the documented body keys", async () => {
    let captured: { url: string; init: any } | null = null;
    const fakeFetch = vi.fn(async (url: string, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ ok: true }),
      };
    });
    const signWithIrk = vi.fn(async (_umk: Uint8Array, bytes: Uint8Array) => {
      // Return a deterministic 64-byte "signature" derived from the
      // canonical bytes so the test can assert on the hex.
      const out = new Uint8Array(64);
      for (let i = 0; i < 64; i++) out[i] = bytes[i % bytes.length] ?? 0;
      return out;
    });

    const result = await revokeServer(
      {
        userId: USER_ID,
        revokedServerId: SERVER_DOMAIN,
        reason: "stolen",
        umk: new Uint8Array(32),
        signWithIrk,
      },
      {
        fetch: fakeFetch as any,
        origin: "https://flagshipserver.com",
        now: () => 1700000000000,
      },
    );

    expect(result.ok).toBe(true);
    expect(signWithIrk).toHaveBeenCalledTimes(1);
    expect(captured!.url).toBe("https://flagshipserver.com/api/server-registry/revoke");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(captured!.init.body);
    expect(body.request.userId).toBe(USER_ID);
    expect(body.request.revokedServerId).toBe(SERVER_DOMAIN);
    expect(body.request.reason).toBe("stolen");
    expect(body.request.issuedAt).toBe(1700000000000);
    expect(body.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("uses the default origin (flagshipserver.com) when none is passed", async () => {
    let url: string = "";
    const fakeFetch = vi.fn(async (u: string) => {
      url = u;
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    });
    await revokeServer(
      {
        userId: USER_ID,
        revokedServerId: SERVER_DOMAIN,
        reason: "lost",
        umk: new Uint8Array(32),
        signWithIrk: async () => new Uint8Array(64),
      },
      { fetch: fakeFetch as any, now: () => 1 },
    );
    expect(url.startsWith("https://flagshipserver.com/")).toBe(true);
  });
});

describe("P13 — reason-picker validation", () => {
  const baseArgs = {
    userId: USER_ID,
    revokedServerId: SERVER_DOMAIN,
    umk: new Uint8Array(32),
    signWithIrk: async () => new Uint8Array(64),
  };
  const noopFetch = vi.fn(async () => ({
    ok: true, status: 200, text: async () => "", json: async () => ({}),
  }));

  it("accepts each of {lost, stolen, decommissioned}", async () => {
    for (const reason of REVOCATION_REASONS) {
      const r = await revokeServer(
        { ...baseArgs, reason } as any,
        { fetch: noopFetch as any, now: () => 1 },
      );
      expect(r.ok).toBe(true);
    }
  });

  it("rejects any other reason with code=400 before issuing the POST", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200, text: async () => "", json: async () => ({}),
    }));
    await expect(
      revokeServer(
        { ...baseArgs, reason: "borrowed" as any },
        { fetch: fakeFetch as any, now: () => 1 },
      ),
    ).rejects.toMatchObject({ code: "400" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("rejects an empty userId / serverId before issuing the POST", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200, text: async () => "", json: async () => ({}),
    }));
    await expect(
      revokeServer(
        { ...baseArgs, userId: "", reason: "stolen" } as any,
        { fetch: fakeFetch as any, now: () => 1 },
      ),
    ).rejects.toMatchObject({ code: "400" });
    await expect(
      revokeServer(
        { ...baseArgs, revokedServerId: "", reason: "stolen" } as any,
        { fetch: fakeFetch as any, now: () => 1 },
      ),
    ).rejects.toMatchObject({ code: "400" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("refuses to run if signWithIrk / umk are absent (locked webapp)", async () => {
    await expect(
      revokeServer(
        { userId: USER_ID, revokedServerId: SERVER_DOMAIN, reason: "stolen" } as any,
        {},
      ),
    ).rejects.toMatchObject({ code: "400" });
  });
});

describe("P13 — error mapping", () => {
  function mockOnce(status: number, body: any) {
    return vi.fn(async () => ({
      ok: false,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }));
  }

  const baseArgs = {
    userId: USER_ID,
    revokedServerId: SERVER_DOMAIN,
    reason: "stolen" as const,
    umk: new Uint8Array(32),
    signWithIrk: async () => new Uint8Array(64),
  };

  it("maps 403 (signature mismatch / stale) to code=403", async () => {
    const fakeFetch = mockOnce(403, { error: "invalid signature" });
    await expect(
      revokeServer(baseArgs, { fetch: fakeFetch as any, now: () => 1 }),
    ).rejects.toMatchObject({ code: "403" });
  });

  it("maps 404 (unknown server) to code=404", async () => {
    const fakeFetch = mockOnce(404, { error: "unknown server" });
    await expect(
      revokeServer(baseArgs, { fetch: fakeFetch as any, now: () => 1 }),
    ).rejects.toMatchObject({ code: "404" });
  });

  it("maps a network failure to code=network", async () => {
    const fakeFetch = vi.fn(async () => { throw new Error("offline"); });
    await expect(
      revokeServer(baseArgs, { fetch: fakeFetch as any, now: () => 1 }),
    ).rejects.toMatchObject({ code: "network" });
  });
});

describe("P13 — countdown timing", () => {
  it("ticks 3 → 2 → 1 → 0 across three seconds", async () => {
    vi.useFakeTimers();
    try {
      const ticks: number[] = [];
      const p = countdownConfirm({ onTick: (s) => ticks.push(s) });
      // Initial tick fires synchronously.
      expect(ticks).toEqual([3]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks).toEqual([3, 2]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks).toEqual([3, 2, 1]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks).toEqual([3, 2, 1, 0]);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts mid-countdown when the abort signal fires", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const ticks: number[] = [];
      const p = countdownConfirm({ signal: controller.signal, onTick: (s) => ticks.push(s) });
      // Race: catch the rejection up-front so we don't get unhandledRejection.
      const settled = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks).toEqual([3, 2]);
      controller.abort();
      const err = await settled;
      expect(err).toMatchObject({ code: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects synchronously when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      countdownConfirm({ signal: controller.signal, onTick: () => {} }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

// Sanity test: ensure the round-trip wire bytes (canonical bytes
// computed in the webapp and parsed/re-derived by a notional verifier)
// produce a single, consistent hex signature. Aimed at the
// "all 3 surfaces produce wire-identical envelopes" constraint.
describe("P13 — wire-identity sanity", () => {
  it("a fixed (userId, serverId, reason, issuedAt) canonicalizes to the documented string", () => {
    const fixed = canonicalRevokeBytes({
      userId: "alice",
      revokedServerId: "home.alice.flagship.services",
      reason: "decommissioned",
      issuedAt: 42,
    });
    const literal = "flagship/revoke/v1|alice|home.alice.flagship.services|decommissioned|42";
    expect(new TextDecoder().decode(fixed)).toBe(literal);
    // Bytes (UTF-8) match between encoder runs.
    expect(Array.from(fixed)).toEqual(Array.from(new TextEncoder().encode(literal)));
    // And explicit byte counters — pin against length drift.
    expect(fixed.length).toBe(literal.length);
  });
});

// Re-export bytesToHex/hexToBytes references so the unused import doesn't
// trip the noUncheckedIndexedAccess project-wide lint.
void bytesToHex; void hexToBytes;

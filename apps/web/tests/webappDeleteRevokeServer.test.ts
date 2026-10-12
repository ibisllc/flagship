// Delete server (every server), reversible Revoke, Un-revoke — webapp.
//
// Pins:
//   - the ServerUnrevocation canonical bytes + signature golden vector shared
//     with @flagship/protocol and the Swift/Kotlin ports;
//   - the un-revoke POST and its 409 mapping, and that it signs under the
//     sensitive-order key (admin root when pinned);
//   - the typed-name gate;
//   - the delete ordering (erase order first and best-effort, release must
//     succeed, wipe-now with no final flush);
//   - which revoked servers stay listed;
//   - the offline page still offering Delete / Revoke / Un-revoke.

import { describe, expect, it, vi } from "vitest";
import { ed, verifyServerUnrevocation } from "@flagship/protocol";
import {
  canonicalUnrevokeBytes,
  TAG_SERVER_UNREVOKE,
  unrevokeServer,
} from "../public/webapp/lib/revokeServer.js";
import { makeSensitiveSigner, SENSITIVE_TAGS } from "../public/webapp/lib/adminRoot.js";
import {
  deleteNameMatches,
  deleteServer,
  deleteToastCopy,
  isListableRevocation,
  isRecentlyDeleted,
  serverLabelOf,
} from "../public/webapp/lib/deleteServer.js";
import { reconcileRevokedServers } from "../public/webapp/views/home.js";
import {
  isRestorableRevokedPod,
  renderDangerZoneCard,
  renderUnreachableDetail,
} from "../public/webapp/views/server-detail.js";

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function unhex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const SEED = "ae7204fc0384c689bfb676523656b66d804cb51c262c7552b03e51bba8767ac3";
const PUB = "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4";
const SIG =
  "669bfc297531e634d70af2ec4c846aa0eb249bf5c00ce5e6e065a63ce5c86c175f4b930894e45b68ef858f4d397c4442a0faf12ef8c35e2b3d2c949a6b3bbe03";
const REQ = { username: "harry", serverDomain: "home.harry.flagship.services", issuedAt: 1700000000000 };
const STK = "ab".repeat(32);

function okResp(body: unknown = { ok: true }) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function errResp(status: number, body: unknown = { error: "nope" }) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("ServerUnrevocation canonical bytes (golden vector)", () => {
  it("matches the pinned canonical string", () => {
    expect(TAG_SERVER_UNREVOKE).toBe("flagship/server-unrevoke/v1");
    expect(new TextDecoder().decode(canonicalUnrevokeBytes(REQ))).toBe(
      "flagship/server-unrevoke/v1|harry|home.harry.flagship.services|1700000000000",
    );
  });

  it("signs to the pinned signature and verifies under @flagship/protocol", () => {
    const seed = unhex(SEED);
    expect(hex(ed.getPublicKey(seed))).toBe(PUB);
    const sig = ed.sign(canonicalUnrevokeBytes(REQ), seed);
    expect(hex(sig)).toBe(SIG);
    expect(verifyServerUnrevocation(REQ, sig, unhex(PUB))).toBe(true);
  });

  it("is a sensitive order: signs under the admin root when one is pinned", async () => {
    expect(SENSITIVE_TAGS.has("flagship/server-unrevoke/v1")).toBe(true);
    const legacy = vi.fn(async () => new Uint8Array(64).fill(1));
    const admin = vi.fn(async () => new Uint8Array(64).fill(2));
    const signer = makeSensitiveSigner(new Uint8Array(32), legacy, { signWithAdminRoot: admin });
    await signer(new Uint8Array(32), canonicalUnrevokeBytes(REQ));
    expect(admin).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("unrevokeServer", () => {
  it("POSTs the documented body to /api/server-registry/unrevoke", async () => {
    const seed = unhex(SEED);
    const fetch = vi.fn(async (_url: string, _init: any) => okResp({ ok: true, unrevokedAt: 1, dnsRepublished: 2 }));
    const out = await unrevokeServer(
      {
        username: REQ.username,
        serverDomain: REQ.serverDomain,
        umk: new Uint8Array(32),
        signWithIrk: async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, seed),
      },
      { fetch, origin: "https://com.test", now: () => REQ.issuedAt, requireOwnerProfile: () => {} },
    );
    expect(out).toEqual({ ok: true, body: { ok: true, unrevokedAt: 1, dnsRepublished: 2 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://com.test/api/server-registry/unrevoke");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ request: REQ, signature: SIG });
  });

  it("maps a 409 to the can't-be-restored copy", async () => {
    const fetch = vi.fn(async () => errResp(409, { error: "x" }));
    await expect(
      unrevokeServer(
        { username: "harry", serverDomain: REQ.serverDomain, umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64) },
        { fetch, requireOwnerProfile: () => {} },
      ),
    ).rejects.toMatchObject({ code: "409", message: expect.stringContaining("can't be restored") });
  });

  it("refuses on a locked session", async () => {
    await expect(
      unrevokeServer(
        { username: "harry", serverDomain: REQ.serverDomain, umk: null, signWithIrk: null },
        { requireOwnerProfile: () => {} },
      ),
    ).rejects.toThrow(/unlock/);
  });
});

describe("typed-name gate", () => {
  const fqdn = "home2.plucky-avocet.flagship.services";
  it("accepts the server label, trimmed and case-insensitive", () => {
    expect(serverLabelOf(fqdn)).toBe("home2");
    expect(deleteNameMatches("home2", fqdn)).toBe(true);
    expect(deleteNameMatches("  HOME2 ", fqdn)).toBe(true);
  });
  it("rejects anything else", () => {
    expect(deleteNameMatches("", fqdn)).toBe(false);
    expect(deleteNameMatches("home", fqdn)).toBe(false);
    expect(deleteNameMatches(fqdn, fqdn)).toBe(false);
    expect(deleteNameMatches("home2", "")).toBe(false);
  });
});

describe("deleteServer ordering", () => {
  const base = {
    serverDomain: "home.harry.flagship.services",
    username: "harry",
    umk: new Uint8Array(32),
    irkPubHex: "cd".repeat(32),
    signWithIrk: async () => new Uint8Array(64),
  };

  it("deposits a wipe-now erase order, then releases the name, with one signer", async () => {
    const calls: string[] = [];
    const signer = vi.fn(async () => new Uint8Array(64));
    const fetch = vi.fn(async (url: string, init: any) => {
      calls.push(url);
      if (url.endsWith("/decommission")) {
        const body = JSON.parse(init.body);
        expect(body.order).toMatchObject({
          podCanonical: "home.harry.flagship.services",
          retiredStkPubHex: STK,
          finalBackup: false,
          diskDisposition: "wipe-now",
          backupEpoch: 0,
          issuedAt: 1234,
        });
        expect(body.order.nonce).toMatch(/^[0-9a-f]{64}$/);
      }
      return okResp();
    });
    const out = await deleteServer(
      { ...base, identityPubKey: STK.toUpperCase(), signWithIrk: signer },
      { fetch, origin: "https://com.test", now: () => 1234, requireOwnerProfile: () => {} },
    );
    expect(out).toEqual({ ok: true, depositOk: true });
    expect(calls).toEqual([
      "https://com.test/api/server/home.harry.flagship.services/decommission",
      "https://com.test/api/server/release",
    ]);
    // order + mailbox auth + release, all through the one signer.
    expect(signer).toHaveBeenCalledTimes(3);
    expect(isRecentlyDeleted("HOME.harry.flagship.services", 1234)).toBe(true);
  });

  it("a failed erase order doesn't stop the release", async () => {
    const release = vi.fn(async () => ({ ok: true }));
    const out = await deleteServer(
      { ...base, serverDomain: "a.harry.flagship.services", identityPubKey: STK },
      {
        depositDecommission: vi.fn(async () => { throw new Error("offline"); }),
        releaseServerName: release,
      },
    );
    expect(out.depositOk).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(deleteToastCopy("a.harry.flagship.services", false)).toBe(
      "Deleted a. It couldn't be asked to erase itself.",
    );
  });

  it("a failed release aborts and leaves the server listed", async () => {
    await expect(
      deleteServer(
        { ...base, serverDomain: "b.harry.flagship.services", identityPubKey: STK },
        {
          depositDecommission: vi.fn(async () => ({ ok: true })),
          releaseServerName: vi.fn(async () => { throw new Error("release failed (403)"); }),
        },
      ),
    ).rejects.toThrow(/release failed/);
    expect(isRecentlyDeleted("b.harry.flagship.services")).toBe(false);
  });

  it("skips the erase order when the server never registered a box key", async () => {
    const deposit = vi.fn();
    const out = await deleteServer(
      { ...base, serverDomain: "c.harry.flagship.services", identityPubKey: null },
      { depositDecommission: deposit, releaseServerName: vi.fn(async () => ({ ok: true })) },
    );
    expect(deposit).not.toHaveBeenCalled();
    expect(out.depositOk).toBeNull();
    expect(deleteToastCopy("c.harry.flagship.services", null)).toBe("Deleted c.");
    expect(deleteToastCopy("c.harry.flagship.services", true)).toBe(
      "Deleted c. If it's online it will erase itself and power off.",
    );
  });

  it("looks the box key up when the caller has no /pods row", async () => {
    const deposit = vi.fn(async () => ({ ok: true }));
    await deleteServer(
      { ...base, serverDomain: "d.harry.flagship.services" },
      {
        resolveIdentity: async () => STK,
        depositDecommission: deposit,
        releaseServerName: vi.fn(async () => ({ ok: true })),
      },
    );
    expect(deposit.mock.calls[0]![0]).toMatchObject({ retiredStkPubHex: STK });
  });

  it("a companion's queued release is returned pending, not finished", async () => {
    const out = await deleteServer(
      { ...base, serverDomain: "e.harry.flagship.services", identityPubKey: null },
      { releaseServerName: vi.fn(async () => ({ ok: false, pending: true, requestId: "r" })) },
    );
    expect(out).toMatchObject({ pending: true, requestId: "r" });
    expect(isRecentlyDeleted("e.harry.flagship.services")).toBe(false);
  });
});

describe("revoked servers in the list", () => {
  const S = (id: string, revoked: any = null) => ({ serverId: id, revoked });
  const pods = new Map<string, any>([
    ["lost.h.flagship.services", { revokedAt: 5, revocationReason: "lost" }],
    ["stolen.h.flagship.services", { revokedAt: 5, revocationReason: "stolen" }],
    ["decom.h.flagship.services", { revokedAt: 5, revocationReason: "decommissioned" }],
    ["released.h.flagship.services", { revokedAt: 5, revocationReason: "released" }],
    ["noreason.h.flagship.services", { revokedAt: 5, revocationReason: null }],
    ["live.h.flagship.services", { revokedAt: null, revocationReason: null }],
    ["oldworker.h.flagship.services", { revokedAt: 5 }],
  ]);

  it("keeps lost/stolen/decommissioned as Revoked and hides every other reason", () => {
    const out = reconcileRevokedServers(
      [
        S("lost.h.flagship.services"),
        S("stolen.h.flagship.services"),
        S("decom.h.flagship.services"),
        S("released.h.flagship.services"),
        S("noreason.h.flagship.services"),
        S("live.h.flagship.services", { reason: "lost", at: 1 }),
        S("oldworker.h.flagship.services", { reason: "stolen", at: 5 }),
        S("nopod.h.flagship.services"),
        S("nopod-transferred.h.flagship.services", { reason: "transferred", at: 1 }),
      ],
      pods,
    );
    expect(out.map((s) => [s.serverId, s.revoked?.reason ?? null])).toEqual([
      ["lost.h.flagship.services", "lost"],
      ["stolen.h.flagship.services", "stolen"],
      ["decom.h.flagship.services", "decommissioned"],
      ["live.h.flagship.services", null],
      ["oldworker.h.flagship.services", "stolen"],
      ["nopod.h.flagship.services", null],
    ]);
    expect(isListableRevocation("lost")).toBe(true);
    expect(isListableRevocation("released")).toBe(false);
    expect(isListableRevocation(null)).toBe(false);
  });
});

describe("server page Danger zone", () => {
  const fqdn = "home2.plucky-avocet.flagship.services";

  it("offers reversible Revoke and Delete on a live server, without the old irreversible copy", () => {
    const html = renderDangerZoneCard({ serverFqdn: fqdn, username: "plucky-avocet", revoked: false });
    expect(html).toContain('id="revoke-server-btn"');
    expect(html).toContain("Revoke server (reversible)");
    expect(html).toContain('id="delete-server-btn"');
    expect(html).not.toContain("unrevoke-server-btn");
    expect(html).not.toMatch(/cannot be undone|brick/i);
  });

  it("offers Un-revoke instead of Revoke on a revoked server", () => {
    const html = renderDangerZoneCard({ serverFqdn: fqdn, username: "plucky-avocet", revoked: true });
    expect(html).toContain('id="unrevoke-server-btn"');
    expect(html).not.toContain('id="revoke-server-btn"');
    expect(html).toContain('id="delete-server-btn"');
  });

  it("the unreachable page still carries the Danger zone", () => {
    const offline = renderUnreachableDetail({ serverFqdn: fqdn, username: "u", revoked: false, message: "HTTP 502" });
    expect(offline).toContain("HTTP 502");
    expect(offline).toContain('id="revoke-server-btn"');
    expect(offline).toContain('id="delete-server-btn"');
    const revoked = renderUnreachableDetail({ serverFqdn: fqdn, username: "u", revoked: true, message: "" });
    expect(revoked).toContain('id="unrevoke-server-btn"');
    expect(revoked).toContain('id="delete-server-btn"');
  });

  it("only a lost/stolen/decommissioned revoke is restorable", () => {
    expect(isRestorableRevokedPod({ revokedAt: 1, revocationReason: "stolen" })).toBe(true);
    expect(isRestorableRevokedPod({ revokedAt: 1, revocationReason: "released" })).toBe(false);
    expect(isRestorableRevokedPod({ revokedAt: null, revocationReason: null })).toBe(false);
    expect(isRestorableRevokedPod(null)).toBe(false);
    // An older Worker without the field: offer it and let .com decide.
    expect(isRestorableRevokedPod({ revokedAt: 1 })).toBe(true);
  });
});

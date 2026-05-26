/**
 * P6 daemon BFF — /api/screens/app-invite/{issue,list,access,revoke}.
 *
 * Four HTTP routes + a pure projector pair (`projectPendingInvites`,
 * `projectAccessRows`). Tests cover:
 *   1. Issue happy path — returns { secret, expiresAt }, persists to store.
 *   2. List returns issued (still-pending, non-expired) invites.
 *   3. Access returns redeemed rows (drawn from listActiveAccess).
 *   4. Revoke scope=invite removes from list.
 *   5. Revoke scope=access removes from access.
 *   6. Expired invites drop from list (filter-on-read).
 *   7. Idempotent revoke (second call returns alreadyRevoked: true).
 *   8. 503 when no appInvite store is wired.
 */

import { describe, expect, it } from "vitest";
import { InMemoryAppInviteStore, type AppAccessRow } from "../../src/inviteHandler.js";
import {
  buildScreensHttp,
  type ScreensHttpDeps,
} from "../../src/screens/screensHttp.js";
import type { HttpRequest } from "../../src/runtime.js";
import type {
  AppInviteAccessResponse,
  AppInviteIssueResponse,
  AppInviteListResponse,
  AppInviteRevokeResponse,
} from "../../src/screens/types.js";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";
const SID = "alice-habits";

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: { "x-flagship-session": "tok-good" },
    body: Buffer.alloc(0),
    ...over,
  };
}

function fakeGate(allowToken = "tok-good") {
  return {
    has(t: string) {
      return t === allowToken;
    },
    check(r: HttpRequest) {
      const hdr = r.headers["x-flagship-session"];
      if (typeof hdr === "string" && hdr === allowToken) return null;
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "unauthorized" }),
      };
    },
  };
}

function commonDeps(now = 5_000): Omit<ScreensHttpDeps, "gate"> {
  return {
    serverFqdn: SERVER_FQDN,
    username: USERNAME,
    daemonVersion: "0.0.1-test",
    startedAt: 1_000,
    now: () => now,
  };
}

function withStore(
  store: InMemoryAppInviteStore,
  now = 5_000,
  randFn?: (n: number) => Uint8Array,
) {
  return buildScreensHttp({
    ...commonDeps(now),
    gate: fakeGate(),
    appInvite: {
      store,
      serverFqdn: SERVER_FQDN,
      now: () => now,
      randomBytes: randFn,
    },
  });
}

const TAG_HEX = "00112233445566778899aabbccddeeff"; // 16 bytes

// ---------- 1. Issue happy path ------------------------------------------

describe("POST /api/screens/app-invite/issue", () => {
  it("503s when no store wired", async () => {
    const handle = buildScreensHttp({ ...commonDeps(), gate: fakeGate() });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: null,
          }),
        ),
      }),
    );
    expect(r?.status).toBe(503);
  });

  it("issues a fresh bearer invite and returns { secret, expiresAt }", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store, 5_000);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: "from harry's phone",
          }),
        ),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as AppInviteIssueResponse;
    expect(typeof body.secret).toBe("string");
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresAt).toBeGreaterThan(5_000);
    // The default TTL is 24h, so expiresAt ≈ now + 86_400_000.
    expect(body.expiresAt - 5_000).toBe(24 * 60 * 60_000);
    // Side-effect: the store now has one pending row.
    const pending = await store.listPendingInvites(SID);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.role).toBe("member");
    expect(pending[0]!.contextNote).toBe("from harry's phone");
  });

  it("400s on malformed opaqueTag (not 16 bytes)", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: "deadbeef", // 4 bytes, not 16
            contextNote: null,
          }),
        ),
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("400s on overlong contextNote", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: "x".repeat(281),
          }),
        ),
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("requires the paired-session gate", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: null,
          }),
        ),
      }),
    );
    expect(r?.status).toBe(401);
  });
});

// ---------- 2. List returns issued invites -------------------------------

describe("GET /api/screens/app-invite/list/:serviceId", () => {
  it("503s when no store wired", async () => {
    const handle = buildScreensHttp({ ...commonDeps(), gate: fakeGate() });
    const r = await handle(req({ path: `/api/screens/app-invite/list/${SID}` }));
    expect(r?.status).toBe(503);
  });

  it("returns issued invites with the wire-shape the webapp reads", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    // Issue twice, then list.
    for (let i = 0; i < 2; i++) {
      const tag = i === 0 ? TAG_HEX : "aabbccddeeff00112233445566778899";
      await handle(
        req({
          method: "POST",
          path: "/api/screens/app-invite/issue",
          body: Buffer.from(
            JSON.stringify({
              serviceId: SID,
              role: i === 0 ? "member" : "admin",
              opaqueTag: tag,
              contextNote: null,
            }),
          ),
        }),
      );
    }
    const r = await handle(req({ path: `/api/screens/app-invite/list/${SID}` }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as AppInviteListResponse;
    expect(body.pending).toHaveLength(2);
    // Every row carries the shape `invite-manage.js` reads.
    for (const p of body.pending) {
      expect(typeof p.opaqueTag).toBe("string");
      expect(p.opaqueTag).toMatch(/^[0-9a-f]{32}$/);
      expect(typeof p.inviteId).toBe("string");
      expect(typeof p.role).toBe("string");
      expect(typeof p.expiresAt).toBe("number");
    }
  });

  it("isolates per-serviceId — returns empty for an unknown id", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: null,
          }),
        ),
      }),
    );
    const r = await handle(
      req({ path: `/api/screens/app-invite/list/alice-other-service` }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as AppInviteListResponse;
    expect(body.pending).toEqual([]);
  });
});

// ---------- 3. Access returns redeemed rows ------------------------------

describe("GET /api/screens/app-invite/access/:serviceId", () => {
  it("503s when no store wired", async () => {
    const handle = buildScreensHttp({ ...commonDeps(), gate: fakeGate() });
    const r = await handle(req({ path: `/api/screens/app-invite/access/${SID}` }));
    expect(r?.status).toBe(503);
  });

  it("returns active access rows (drawn from listActiveAccess)", async () => {
    const store = new InMemoryAppInviteStore();
    // Pre-seed two access rows — the live redeem path is exercised
    // elsewhere (inviteHandler.test.ts); here we just verify the BFF's
    // projection of listActiveAccess().
    const tagA = hexToBytes(TAG_HEX);
    const tagB = hexToBytes("aabbccddeeff00112233445566778899");
    const access: AppAccessRow[] = [
      {
        serviceId: SID,
        irkPubHex: "a".repeat(64),
        role: "member",
        opaqueTag: tagA,
        grantedAt: 4_000,
        revokedAt: null,
        sessionToken: "tok-1",
      },
      {
        serviceId: SID,
        irkPubHex: "b".repeat(64),
        role: "admin",
        opaqueTag: tagB,
        grantedAt: 5_000,
        revokedAt: null,
        sessionToken: "tok-2",
      },
    ];
    for (const a of access) await store.insertAccess(a);

    const handle = withStore(store);
    const r = await handle(req({ path: `/api/screens/app-invite/access/${SID}` }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as AppInviteAccessResponse;
    expect(body.access).toHaveLength(2);
    // Sorted newest-first (grantedAt DESC).
    expect(body.access[0]!.grantedAt).toBe(5_000);
    expect(body.access[0]!.role).toBe("admin");
    expect(body.access[1]!.grantedAt).toBe(4_000);
    // Shape every row.
    for (const a of body.access) {
      expect(typeof a.opaqueTag).toBe("string");
      expect(a.opaqueTag).toMatch(/^[0-9a-f]{32}$/);
      expect(a.irkPubHex).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof a.role).toBe("string");
      expect(typeof a.grantedAt).toBe("number");
    }
  });

  it("returns empty access when nothing redeemed", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const r = await handle(req({ path: `/api/screens/app-invite/access/${SID}` }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as AppInviteAccessResponse;
    expect(body.access).toEqual([]);
  });
});

// ---------- 4. Revoke scope=invite ---------------------------------------

describe("POST /api/screens/app-invite/revoke — scope='invite'", () => {
  it("soft-revokes a pending invite and removes it from the list", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const issueResp = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: null,
          }),
        ),
      }),
    );
    expect(issueResp?.status).toBe(200);
    const pending = await store.listPendingInvites(SID);
    const inviteId = pending[0]!.inviteId;

    const revokeResp = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, inviteId, scope: "invite" }),
        ),
      }),
    );
    expect(revokeResp?.status).toBe(200);
    const revokeBody = JSON.parse(revokeResp!.body as string) as AppInviteRevokeResponse;
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.alreadyRevoked).toBe(false);

    // List should now be empty.
    const listResp = await handle(req({ path: `/api/screens/app-invite/list/${SID}` }));
    const listBody = JSON.parse(listResp!.body as string) as AppInviteListResponse;
    expect(listBody.pending).toEqual([]);
  });

  it("is idempotent — revoking twice returns alreadyRevoked: true on the second call", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: null,
          }),
        ),
      }),
    );
    const pending = await store.listPendingInvites(SID);
    const inviteId = pending[0]!.inviteId;

    // First revoke.
    const r1 = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, inviteId, scope: "invite" }),
        ),
      }),
    );
    expect(r1?.status).toBe(200);
    expect((JSON.parse(r1!.body as string) as AppInviteRevokeResponse).alreadyRevoked).toBe(false);

    // Second revoke — same id, still 200, alreadyRevoked: true.
    const r2 = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, inviteId, scope: "invite" }),
        ),
      }),
    );
    expect(r2?.status).toBe(200);
    expect((JSON.parse(r2!.body as string) as AppInviteRevokeResponse).alreadyRevoked).toBe(true);
  });

  it("400s when inviteId is missing", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(JSON.stringify({ serviceId: SID, scope: "invite" })),
      }),
    );
    expect(r?.status).toBe(400);
  });
});

// ---------- 5. Revoke scope=access ---------------------------------------

describe("POST /api/screens/app-invite/revoke — scope='access'", () => {
  it("soft-revokes a redeemed access row and removes it from the list", async () => {
    const store = new InMemoryAppInviteStore();
    const irkHex = "c".repeat(64);
    await store.insertAccess({
      serviceId: SID,
      irkPubHex: irkHex,
      role: "member",
      opaqueTag: hexToBytes(TAG_HEX),
      grantedAt: 4_000,
      revokedAt: null,
      sessionToken: "tok-c",
    });
    const handle = withStore(store);

    // Confirm row is visible pre-revoke.
    let r = await handle(req({ path: `/api/screens/app-invite/access/${SID}` }));
    expect((JSON.parse(r!.body as string) as AppInviteAccessResponse).access).toHaveLength(1);

    r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, irkPubKey: irkHex, scope: "access" }),
        ),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as AppInviteRevokeResponse;
    expect(body.ok).toBe(true);
    expect(body.alreadyRevoked).toBe(false);

    // Access list now empty.
    r = await handle(req({ path: `/api/screens/app-invite/access/${SID}` }));
    expect((JSON.parse(r!.body as string) as AppInviteAccessResponse).access).toEqual([]);
  });

  it("is idempotent — re-revoking returns alreadyRevoked: true", async () => {
    const store = new InMemoryAppInviteStore();
    const irkHex = "d".repeat(64);
    await store.insertAccess({
      serviceId: SID,
      irkPubHex: irkHex,
      role: "member",
      opaqueTag: hexToBytes(TAG_HEX),
      grantedAt: 4_000,
      revokedAt: null,
      sessionToken: "tok-d",
    });
    const handle = withStore(store);
    const r1 = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, irkPubKey: irkHex, scope: "access" }),
        ),
      }),
    );
    expect(r1?.status).toBe(200);
    const r2 = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, irkPubKey: irkHex, scope: "access" }),
        ),
      }),
    );
    expect(r2?.status).toBe(200);
    expect((JSON.parse(r2!.body as string) as AppInviteRevokeResponse).alreadyRevoked).toBe(true);
  });

  it("400s when irkPubKey is not 32-byte hex", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, irkPubKey: "deadbeef", scope: "access" }),
        ),
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("400s when scope is missing or wrong", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, inviteId: "x", scope: "neither" }),
        ),
      }),
    );
    expect(r?.status).toBe(400);
  });
});

// ---------- 6. Expired invites drop from list ----------------------------

describe("List filtering — expired invites drop off", () => {
  it("filters out invites whose expiresAt is <= now", async () => {
    const store = new InMemoryAppInviteStore();
    // Issue at t=5_000 with default 24h TTL → expiresAt = 5_000 + 86_400_000.
    let handle = withStore(store, 5_000);
    await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "member",
            opaqueTag: TAG_HEX,
            contextNote: null,
          }),
        ),
      }),
    );
    // Pre-expiry — list shows the invite.
    let r = await handle(req({ path: `/api/screens/app-invite/list/${SID}` }));
    expect((JSON.parse(r!.body as string) as AppInviteListResponse).pending).toHaveLength(1);

    // Re-build the handler with a future clock past the TTL.
    handle = withStore(store, 5_000 + 25 * 60 * 60_000);
    r = await handle(req({ path: `/api/screens/app-invite/list/${SID}` }));
    const body = JSON.parse(r!.body as string) as AppInviteListResponse;
    expect(body.pending).toEqual([]);
  });
});

// ---------- 7. End-to-end through buildScreensHttp -----------------------

describe("End-to-end — issue → list → revoke → list", () => {
  it("threads through every endpoint and observes consistent state", async () => {
    const store = new InMemoryAppInviteStore();
    const handle = withStore(store);
    // Issue.
    const issueResp = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        body: Buffer.from(
          JSON.stringify({
            serviceId: SID,
            role: "reader",
            opaqueTag: TAG_HEX,
            contextNote: "for the wiki",
          }),
        ),
      }),
    );
    const issued = JSON.parse(issueResp!.body as string) as AppInviteIssueResponse;
    expect(issued.secret).toMatch(/^[0-9a-f]{64}$/);

    // List shows one.
    let listResp = await handle(req({ path: `/api/screens/app-invite/list/${SID}` }));
    let pending = (JSON.parse(listResp!.body as string) as AppInviteListResponse).pending;
    expect(pending).toHaveLength(1);
    const inviteId = pending[0]!.inviteId;
    expect(pending[0]!.opaqueTag).toBe(TAG_HEX);

    // Revoke that one.
    const revokeResp = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/revoke",
        body: Buffer.from(
          JSON.stringify({ serviceId: SID, inviteId, scope: "invite" }),
        ),
      }),
    );
    expect(revokeResp?.status).toBe(200);

    // List empty again.
    listResp = await handle(req({ path: `/api/screens/app-invite/list/${SID}` }));
    pending = (JSON.parse(listResp!.body as string) as AppInviteListResponse).pending;
    expect(pending).toEqual([]);
  });
});

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

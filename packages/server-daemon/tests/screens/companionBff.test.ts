/**
 * P14 — Companion-browser dock BFF.
 *
 * Coverage:
 *   1. Mint — owner gate, label optional, returns { ticketId, ticketSecret, expiresAt }.
 *   2. Redeem happy — issues a 4h paired-session companion token.
 *   3. Redeem wrong secret — 401, ticket stays consumable by the legitimate caller.
 *   4. Redeem replay — second consume returns 409.
 *   5. Redeem expired — 410.
 *   6. List — projects active companions (tokenPrefix, label, expiresAt, userAgent).
 *   7. Revoke — drops the row; idempotent.
 *   8. Expiry sweep — the gate rejects a companion token past its expiry.
 *   9. Companion-write 403 — at least one representative signed-write endpoint.
 *   10. 503 — no companion deps configured.
 *
 * Notes:
 *   - We construct a real `FilePairedSessionStore` against an in-memory
 *     `now` so we can fast-forward the clock past the 4h companion TTL
 *     without sleeping.
 *   - The redeem path is PUBLIC: it must answer even when the gate
 *     would otherwise 401. We probe that explicitly.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import {
  InMemoryCompanionTicketStore,
  sha256HexOfHex,
} from "../../src/companion/companionTicketStore.js";
import {
  FilePairedSessionStore,
  defaultPairedSessionPath,
} from "../../src/pairedSessionStore.js";
import {
  InMemoryAppInviteStore,
} from "../../src/inviteHandler.js";
import type { HttpRequest } from "../../src/runtime.js";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";

function tempPairedSessionsStore() {
  const dir = mkdtempSync(join(tmpdir(), "companion-bff-"));
  const store = new FilePairedSessionStore(defaultPairedSessionPath(dir));
  return store;
}

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: {},
    body: Buffer.alloc(0),
    ...over,
  };
}

function withOwnerToken(over: Partial<HttpRequest>, token = "owner-tok"): HttpRequest {
  return req({
    ...over,
    headers: { "x-flagship-session": token, ...(over.headers ?? {}) },
  });
}

async function buildHarness(opts?: { now?: () => number; randBytesFn?: (n: number) => Uint8Array }) {
  const now = opts?.now ?? (() => 5_000);
  const pairedSessions = tempPairedSessionsStore();
  // Register the owner token so the gate accepts it.
  await pairedSessions.add("owner-tok-aaaaaaaaaaaa", "phone-paired", now());
  // Override the gate's `now()` so companion expiry checks use the
  // same clock as the BFF tests.
  pairedSessions.now = now;
  const ticketStore = new InMemoryCompanionTicketStore();
  const handle = buildScreensHttp({
    gate: pairedSessions,
    serverFqdn: SERVER_FQDN,
    username: USERNAME,
    daemonVersion: "0.0.1-test",
    startedAt: 1_000,
    now,
    pairedSessions,
    companion: {
      ticketStore,
      pairedSessions,
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      now,
      randomBytes: opts?.randBytesFn,
    },
    // Wire app-invite so the companion-write gate test can hit a real
    // signed-write endpoint (issue) instead of needing a separate
    // harness for that one.
    appInvite: {
      store: new InMemoryAppInviteStore(),
      serverFqdn: SERVER_FQDN,
      now,
    },
  });
  return { handle, ticketStore, pairedSessions };
}

const OWNER_TOKEN = "owner-tok-aaaaaaaaaaaa";

// ---------- 1. Mint ------------------------------------------------------

describe("POST /api/screens/companion/mint-ticket", () => {
  it("503s when no companion deps wired", async () => {
    const pairedSessions = tempPairedSessionsStore();
    await pairedSessions.add(OWNER_TOKEN, "phone-paired", 1_000);
    const handle = buildScreensHttp({
      gate: pairedSessions,
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      daemonVersion: "0.0.1-test",
      startedAt: 1_000,
      now: () => 5_000,
      pairedSessions,
    });
    const r = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from("{}"),
      }, OWNER_TOKEN),
    );
    expect(r?.status).toBe(503);
  });

  it("requires the paired-session gate", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from("{}"),
      }),
    );
    expect(r?.status).toBe(401);
  });

  it("mints a ticket and returns { ticketId, ticketSecret, expiresAt }", async () => {
    const { handle, ticketStore } = await buildHarness({ now: () => 5_000 });
    const r = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from("{}"),
      }, OWNER_TOKEN),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(typeof body.ticketId).toBe("string");
    expect(body.ticketId).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof body.ticketSecret).toBe("string");
    expect(body.ticketSecret).toMatch(/^[0-9a-f]{64}$/);
    // Default ticket TTL is 60s.
    expect(body.expiresAt - 5_000).toBe(60_000);
    // Persisted as a pending row.
    const all = ticketStore._all();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("pending");
  });
});

// ---------- 2-5. Redeem --------------------------------------------------

describe("POST /api/companion/redeem (PUBLIC)", () => {
  async function mintOne(handle: any) {
    const r = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from(JSON.stringify({ label: "iMac" })),
      }, OWNER_TOKEN),
    );
    return JSON.parse(r!.body as string) as {
      ticketId: string;
      ticketSecret: string;
      expiresAt: number;
    };
  }

  it("503s when no companion deps wired", async () => {
    const pairedSessions = tempPairedSessionsStore();
    const handle = buildScreensHttp({
      gate: pairedSessions,
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      daemonVersion: "0.0.1-test",
      startedAt: 1_000,
      now: () => 5_000,
      pairedSessions,
    });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({ ticketId: "x", ticketSecret: "y" })),
      }),
    );
    expect(r?.status).toBe(503);
  });

  it("redeems happy path with NO paired-session header (the ticket IS the proof)", async () => {
    const { handle, pairedSessions } = await buildHarness({ now: () => 5_000 });
    const mint = await mintOne(handle);

    const r = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        // NB: no x-flagship-session header — this MUST work anyway.
        headers: { "user-agent": "Mozilla/5.0 (FakeOS) Chromium/126" },
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(typeof body.companionSessionToken).toBe("string");
    expect(body.companionSessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresAt - 5_000).toBe(4 * 60 * 60_000);
    expect(body.podBaseUrl).toBe(`https://${SERVER_FQDN}`);
    expect(body.username).toBe(USERNAME);

    // The new companion row landed in the paired-session store, flagged.
    const row = pairedSessions.get(body.companionSessionToken);
    expect(row?.companion).toBe(true);
    expect(row?.expiresAt).toBe(body.expiresAt);
    expect(row?.companionUserAgent).toContain("Mozilla/5.0");

    // The ticket is now consumed.
    const r2 = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    expect(r2?.status).toBe(409);
  });

  it("401s on wrong secret; legitimate redeem still works after", async () => {
    const { handle } = await buildHarness({ now: () => 5_000 });
    const mint = await mintOne(handle);

    const bad = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: "f".repeat(64),
        })),
      }),
    );
    expect(bad?.status).toBe(401);

    const good = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    expect(good?.status).toBe(200);
  });

  it("410s on expired ticket", async () => {
    let nowMs = 5_000;
    const { handle } = await buildHarness({ now: () => nowMs });
    const mint = await mintOne(handle);
    // Advance the clock past the 60s ticket TTL.
    nowMs = mint.expiresAt + 1;
    const r = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    expect(r?.status).toBe(410);
  });

  it("400s on missing body fields", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({ ticketId: "x" })), // no secret
      }),
    );
    expect(r?.status).toBe(400);
  });
});

// ---------- 6. List ------------------------------------------------------

describe("GET /api/screens/companion/list", () => {
  it("returns active companion summaries with tokenPrefix + label + expiresAt", async () => {
    const { handle } = await buildHarness({ now: () => 5_000 });
    // Mint + redeem.
    const mintResp = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from(JSON.stringify({ label: "iPad" })),
      }, OWNER_TOKEN),
    );
    const mint = JSON.parse(mintResp!.body as string);
    await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        headers: { "user-agent": "Mozilla/5.0 iPad" },
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );

    const r = await handle(
      withOwnerToken({
        method: "GET",
        path: "/api/screens/companion/list",
      }, OWNER_TOKEN),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.companions).toHaveLength(1);
    const c = body.companions[0];
    expect(typeof c.tokenPrefix).toBe("string");
    expect(c.tokenPrefix.length).toBe(12);
    expect(c.userAgent).toContain("iPad");
    expect(typeof c.expiresAt).toBe("number");
    expect(typeof c.redeemedAt).toBe("number");
  });

  it("returns an empty list when nothing is docked", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      withOwnerToken({
        method: "GET",
        path: "/api/screens/companion/list",
      }, OWNER_TOKEN),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(body.companions).toEqual([]);
  });
});

// ---------- 7. Revoke ----------------------------------------------------

describe("POST /api/screens/companion/revoke", () => {
  it("revokes a companion by tokenPrefix; subsequent calls are still 200 (idempotent)", async () => {
    const { handle } = await buildHarness({ now: () => 5_000 });
    // Set up: mint + redeem.
    const mintResp = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from(JSON.stringify({ label: "iMac" })),
      }, OWNER_TOKEN),
    );
    const mint = JSON.parse(mintResp!.body as string);
    const redeem = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    const r0 = JSON.parse(redeem!.body as string);
    const prefix = r0.companionSessionToken.slice(0, 12);

    const rev1 = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/revoke",
        body: Buffer.from(JSON.stringify({ tokenPrefix: prefix })),
      }, OWNER_TOKEN),
    );
    expect(rev1?.status).toBe(200);

    // List now empty.
    const list = await handle(
      withOwnerToken({
        method: "GET",
        path: "/api/screens/companion/list",
      }, OWNER_TOKEN),
    );
    expect(JSON.parse(list!.body as string).companions).toEqual([]);

    // Re-revoke — idempotent.
    const rev2 = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/revoke",
        body: Buffer.from(JSON.stringify({ tokenPrefix: prefix })),
      }, OWNER_TOKEN),
    );
    expect(rev2?.status).toBe(200);
  });

  it("400s on short prefix", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/revoke",
        body: Buffer.from(JSON.stringify({ tokenPrefix: "abc" })),
      }, OWNER_TOKEN),
    );
    expect(r?.status).toBe(400);
  });
});

// ---------- 8. Expiry sweep ----------------------------------------------

describe("Companion-session expiry", () => {
  it("the gate rejects an expired companion token with 401", async () => {
    let nowMs = 5_000;
    const { handle, pairedSessions } = await buildHarness({ now: () => nowMs });
    // Mint + redeem at t=5_000.
    const mintResp = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from(JSON.stringify({ label: "iMac" })),
      }, OWNER_TOKEN),
    );
    const mint = JSON.parse(mintResp!.body as string);
    const redeem = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    const companionToken = (JSON.parse(redeem!.body as string)).companionSessionToken;

    // Pre-expiry — a read endpoint works.
    const ok = await handle(
      req({
        method: "GET",
        path: "/api/screens/server-detail",
        headers: { "x-flagship-session": companionToken },
      }),
    );
    expect(ok?.status).toBe(200);

    // Sweep — fast-forward past the 4h TTL.
    nowMs = 5_000 + 4 * 60 * 60_000 + 1;
    pairedSessions.now = () => nowMs;
    const denied = await handle(
      req({
        method: "GET",
        path: "/api/screens/server-detail",
        headers: { "x-flagship-session": companionToken },
      }),
    );
    expect(denied?.status).toBe(401);
  });
});

// ---------- 9. Companion-write 403 ---------------------------------------

describe("Companion write-gate", () => {
  it("returns 403 with code 'companion-write-not-allowed' for a representative signed-write endpoint", async () => {
    const { handle } = await buildHarness({ now: () => 5_000 });
    // Mint + redeem.
    const mintResp = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from(JSON.stringify({ label: "iMac" })),
      }, OWNER_TOKEN),
    );
    const mint = JSON.parse(mintResp!.body as string);
    const redeem = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    const companionToken = (JSON.parse(redeem!.body as string)).companionSessionToken;

    // Companion attempts a signed-write — app-invite/issue.
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/app-invite/issue",
        headers: { "x-flagship-session": companionToken },
        body: Buffer.from(JSON.stringify({
          serviceId: "alice-habits",
          role: "member",
          opaqueTag: "00112233445566778899aabbccddeeff",
          contextNote: null,
        })),
      }),
    );
    expect(r?.status).toBe(403);
    const body = JSON.parse(r!.body as string);
    expect(body.code).toBe("companion-write-not-allowed");
    expect(typeof body.message).toBe("string");
  });

  it("companions cannot mint MORE companions (mint-ticket is companion-write-blocked)", async () => {
    const { handle } = await buildHarness({ now: () => 5_000 });
    const mintResp = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from("{}"),
      }, OWNER_TOKEN),
    );
    const mint = JSON.parse(mintResp!.body as string);
    const redeem = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    const companionToken = (JSON.parse(redeem!.body as string)).companionSessionToken;

    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        headers: { "x-flagship-session": companionToken },
        body: Buffer.from("{}"),
      }),
    );
    expect(r?.status).toBe(403);
    const body = JSON.parse(r!.body as string);
    expect(body.code).toBe("companion-write-not-allowed");
  });

  it("companions CAN read /api/screens/server-detail (read-only is allowed)", async () => {
    const { handle } = await buildHarness({ now: () => 5_000 });
    const mintResp = await handle(
      withOwnerToken({
        method: "POST",
        path: "/api/screens/companion/mint-ticket",
        body: Buffer.from("{}"),
      }, OWNER_TOKEN),
    );
    const mint = JSON.parse(mintResp!.body as string);
    const redeem = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(JSON.stringify({
          ticketId: mint.ticketId,
          ticketSecret: mint.ticketSecret,
        })),
      }),
    );
    const companionToken = (JSON.parse(redeem!.body as string)).companionSessionToken;

    const r = await handle(
      req({
        method: "GET",
        path: "/api/screens/server-detail",
        headers: { "x-flagship-session": companionToken },
      }),
    );
    expect(r?.status).toBe(200);
  });
});

// ---------- 10. sha256HexOfHex helper ------------------------------------

describe("sha256HexOfHex", () => {
  it("hashes the bytes the hex encodes (not the ASCII string)", () => {
    // 64 zeros = 32 bytes of 0x00.
    const h = sha256HexOfHex("0".repeat(64));
    // SHA-256 of 32 zero bytes:
    expect(h).toBe(
      "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
    );
  });
});

/**
 * P14 Phase 2 — Companion write-relay BFF.
 *
 * Coverage:
 *   1. request-write
 *        - companion-gated (owner gets 401; missing token 401)
 *        - happy path emits requestId + queuedAt + expiresAt (10-min TTL)
 *        - invalid kind → 400 with `kind-not-supported-in-v1`
 *        - malformed body → 400
 *        - expired companion session blocks via the existing gate
 *        - 503 when store unwired
 *   2. pending-writes
 *        - owner-gated
 *        - returns only unresolved + non-expired rows, oldest-first
 *        - surfaces companionTokenPrefix + companionLabel + intent
 *   3. resolve-pending
 *        - owner-gated, approved + denied both work
 *        - idempotent second call → { ok: true, alreadyResolved: true }
 *        - missing requestId → 404
 *        - bad outcome → 400
 *        - companion gets the existing 403 (companion-write-not-allowed)
 *   4. my-pending
 *        - companion-gated (owner gets 401)
 *        - only returns rows that companion submitted (token-prefix filter)
 *        - surfaces approved / denied / expired transitions
 *   5. Expiry sweep
 *        - a 10-min-old pending row reports status: "expired"
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import {
  InMemoryCompanionTicketStore,
} from "../../src/companion/companionTicketStore.js";
import {
  InMemoryCompanionWriteRequestStore,
} from "../../src/companion/companionWriteRequestStore.js";
import {
  FilePairedSessionStore,
  defaultPairedSessionPath,
} from "../../src/pairedSessionStore.js";
import type { HttpRequest, HttpResponse } from "../../src/runtime.js";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";
const OWNER_TOKEN = "owner-tok-aaaaaaaaaaaa";

function tempPairedSessionsStore() {
  const dir = mkdtempSync(join(tmpdir(), "companion-write-relay-"));
  return new FilePairedSessionStore(defaultPairedSessionPath(dir));
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

function withToken(over: Partial<HttpRequest>, token: string): HttpRequest {
  return req({
    ...over,
    headers: { "x-flagship-session": token, ...(over.headers ?? {}) },
  });
}

interface Harness {
  handle: (req: HttpRequest) => Promise<HttpResponse | null>;
  pairedSessions: FilePairedSessionStore;
  writeRequestStore: InMemoryCompanionWriteRequestStore;
  setNow: (n: number) => void;
  mintAndRedeem: (label: string) => Promise<string>;
}

async function buildHarness(opts?: {
  initialNow?: number;
  writeRequestStore?: InMemoryCompanionWriteRequestStore;
  omitWriteRequestStore?: boolean;
}): Promise<Harness> {
  let nowMs = opts?.initialNow ?? 5_000;
  const now = () => nowMs;
  const pairedSessions = tempPairedSessionsStore();
  await pairedSessions.add(OWNER_TOKEN, "phone-paired", now());
  pairedSessions.now = now;
  const ticketStore = new InMemoryCompanionTicketStore();
  const writeRequestStore = opts?.writeRequestStore ??
    new InMemoryCompanionWriteRequestStore();
  const companionDeps = {
    ticketStore,
    pairedSessions,
    serverFqdn: SERVER_FQDN,
    username: USERNAME,
    now,
    ...(opts?.omitWriteRequestStore
      ? {}
      : { writeRequestStore }),
  };
  const handle = buildScreensHttp({
    gate: pairedSessions,
    serverFqdn: SERVER_FQDN,
    username: USERNAME,
    daemonVersion: "0.0.1-test",
    startedAt: 1_000,
    now,
    pairedSessions,
    companion: companionDeps,
  });

  async function mintAndRedeem(label: string): Promise<string> {
    const mintR = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/mint-ticket",
          body: Buffer.from(JSON.stringify({ label })),
        },
        OWNER_TOKEN,
      ),
    );
    const mint = JSON.parse(mintR!.body as string);
    const redeemR = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(
          JSON.stringify({
            ticketId: mint.ticketId,
            ticketSecret: mint.ticketSecret,
          }),
        ),
      }),
    );
    return JSON.parse(redeemR!.body as string).companionSessionToken as string;
  }

  return {
    handle,
    pairedSessions,
    writeRequestStore,
    setNow: (n: number) => {
      nowMs = n;
    },
    mintAndRedeem,
  };
}

// =========================================================================
// 1. POST /api/companion/request-write
// =========================================================================

describe("POST /api/companion/request-write", () => {
  it("503s when no companion deps wired at all", async () => {
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
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(JSON.stringify({ kind: "release-server", intent: {} })),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r?.status).toBe(503);
  });

  it("503s when write-relay store unwired (companion configured but no writeRequestStore)", async () => {
    const { handle } = await buildHarness({ omitWriteRequestStore: true });
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(JSON.stringify({ kind: "release-server", intent: {} })),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r?.status).toBe(503);
    expect(JSON.parse(r!.body as string).error).toMatch(/write-relay/);
  });

  it("401s with no paired-session token", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      req({
        method: "POST",
        path: "/api/companion/request-write",
        body: Buffer.from(JSON.stringify({ kind: "release-server", intent: {} })),
      }),
    );
    expect(r?.status).toBe(401);
  });

  it("401s when called by the OWNER (companion-only endpoint)", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({
              kind: "release-server",
              intent: { serverName: "home" },
            }),
          ),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r?.status).toBe(401);
  });

  it("happy path — companion queues a release-server intent and gets back { requestId, queuedAt, expiresAt }", async () => {
    const { handle, mintAndRedeem, writeRequestStore } = await buildHarness({
      initialNow: 1_000_000,
    });
    const companionToken = await mintAndRedeem("Library iMac");

    const intent = { serverName: "home", reason: "renaming" };
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(JSON.stringify({ kind: "release-server", intent })),
        },
        companionToken,
      ),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string);
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.queuedAt).toBe(1_000_000);
    expect(body.expiresAt - body.queuedAt).toBe(10 * 60_000);

    // Persisted with the companion's tokenPrefix + label.
    const persisted = writeRequestStore._all();
    expect(persisted).toHaveLength(1);
    const row = persisted[0]!;
    expect(row.requestId).toBe(body.requestId);
    expect(row.kind).toBe("release-server");
    expect(row.intent).toEqual(intent);
    expect(row.status).toBe("pending");
    expect(row.companionTokenPrefix).toBe(companionToken.slice(0, 12));
    expect(row.companionLabel).toBe("Library iMac");
  });

  it("400s on unsupported kind with the documented error code", async () => {
    const { handle, mintAndRedeem } = await buildHarness();
    const companionToken = await mintAndRedeem("iMac");
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "install-service", intent: {} }),
          ),
        },
        companionToken,
      ),
    );
    expect(r?.status).toBe(400);
    expect(JSON.parse(r!.body as string).error).toBe(
      "kind-not-supported-in-v1",
    );
  });

  it("400s on malformed body (missing kind / non-object intent / empty body)", async () => {
    const { handle, mintAndRedeem } = await buildHarness();
    const companionToken = await mintAndRedeem("iMac");

    const cases: Array<{ body: Buffer; why: string }> = [
      { body: Buffer.alloc(0), why: "empty body" },
      { body: Buffer.from("{}"), why: "no kind" },
      {
        body: Buffer.from(JSON.stringify({ kind: "release-server" })),
        why: "no intent",
      },
      {
        body: Buffer.from(JSON.stringify({ kind: "release-server", intent: "nope" })),
        why: "non-object intent",
      },
      {
        body: Buffer.from(JSON.stringify({ kind: "release-server", intent: [] })),
        why: "array intent",
      },
    ];

    for (const c of cases) {
      const r = await handle(
        withToken(
          {
            method: "POST",
            path: "/api/companion/request-write",
            body: c.body,
          },
          companionToken,
        ),
      );
      expect(r?.status, `expected 400 for ${c.why}`).toBe(400);
    }
  });

  it("revoke-server is also accepted", async () => {
    const { handle, mintAndRedeem } = await buildHarness();
    const companionToken = await mintAndRedeem("iMac");
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({
              kind: "revoke-server",
              intent: { serverName: "home" },
            }),
          ),
        },
        companionToken,
      ),
    );
    expect(r?.status).toBe(200);
  });

  it("expired companion session is blocked by the gate (401)", async () => {
    let nowMs = 5_000;
    const { handle, mintAndRedeem, setNow } = await buildHarness({
      initialNow: nowMs,
    });
    const companionToken = await mintAndRedeem("iMac");
    nowMs = 5_000 + 4 * 60 * 60_000 + 1;
    setNow(nowMs);
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "home" } }),
          ),
        },
        companionToken,
      ),
    );
    expect(r?.status).toBe(401);
  });
});

// =========================================================================
// 2. GET /api/screens/companion/pending-writes
// =========================================================================

describe("GET /api/screens/companion/pending-writes", () => {
  it("owner-gated (no token → 401)", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      req({ method: "GET", path: "/api/screens/companion/pending-writes" }),
    );
    expect(r?.status).toBe(401);
  });

  it("returns only unresolved + non-expired rows, sorted oldest-first", async () => {
    let nowMs = 1_000_000;
    const { handle, mintAndRedeem, setNow, writeRequestStore } =
      await buildHarness({ initialNow: nowMs });
    const t1 = await mintAndRedeem("A");
    const t2 = await mintAndRedeem("B");

    // queued at 1_000_000
    const r1 = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "x" } }),
          ),
        },
        t1,
      ),
    );
    const id1 = JSON.parse(r1!.body as string).requestId;

    // queued at 1_000_500
    nowMs = 1_000_500;
    setNow(nowMs);
    const r2 = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "revoke-server", intent: { serverName: "y" } }),
          ),
        },
        t2,
      ),
    );
    const id2 = JSON.parse(r2!.body as string).requestId;

    // Third row that will be resolved — should drop out of pending list.
    nowMs = 1_001_000;
    setNow(nowMs);
    const r3 = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "z" } }),
          ),
        },
        t1,
      ),
    );
    const id3 = JSON.parse(r3!.body as string).requestId;
    await writeRequestStore.resolve({
      requestId: id3,
      outcome: "approved",
      resolvedAt: nowMs,
    });

    const list = await handle(
      withToken(
        { method: "GET", path: "/api/screens/companion/pending-writes" },
        OWNER_TOKEN,
      ),
    );
    expect(list?.status).toBe(200);
    const body = JSON.parse(list!.body as string);
    expect(body.pending).toHaveLength(2);
    expect(body.pending[0].requestId).toBe(id1); // oldest first
    expect(body.pending[1].requestId).toBe(id2);
    expect(body.pending[0].kind).toBe("release-server");
    expect(body.pending[0].intent).toEqual({ serverName: "x" });
    expect(body.pending[0].companionLabel).toBe("A");
    expect(typeof body.pending[0].companionTokenPrefix).toBe("string");
    expect(body.pending[0].companionTokenPrefix.length).toBe(12);
    expect(body.pending[1].companionLabel).toBe("B");
  });

  it("filters out rows past their 10-minute TTL", async () => {
    let nowMs = 1_000_000;
    const { handle, mintAndRedeem, setNow } = await buildHarness({
      initialNow: nowMs,
    });
    const t1 = await mintAndRedeem("A");
    await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "x" } }),
          ),
        },
        t1,
      ),
    );
    nowMs = 1_000_000 + 10 * 60_000 + 1;
    setNow(nowMs);
    const list = await handle(
      withToken(
        { method: "GET", path: "/api/screens/companion/pending-writes" },
        OWNER_TOKEN,
      ),
    );
    expect(list?.status).toBe(200);
    expect(JSON.parse(list!.body as string).pending).toEqual([]);
  });

  it("503 when companion configured but write-relay store unwired", async () => {
    const { handle } = await buildHarness({ omitWriteRequestStore: true });
    const r = await handle(
      withToken(
        { method: "GET", path: "/api/screens/companion/pending-writes" },
        OWNER_TOKEN,
      ),
    );
    expect(r?.status).toBe(503);
  });
});

// =========================================================================
// 3. POST /api/screens/companion/resolve-pending
// =========================================================================

describe("POST /api/screens/companion/resolve-pending", () => {
  it("owner-gated (no token → 401)", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/companion/resolve-pending",
        body: Buffer.from(JSON.stringify({ requestId: "x", outcome: "approved" })),
      }),
    );
    expect(r?.status).toBe(401);
  });

  it("companion cannot call resolve-pending — 403 companion-write-not-allowed", async () => {
    const { handle, mintAndRedeem } = await buildHarness();
    const companionToken = await mintAndRedeem("iMac");
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(
            JSON.stringify({ requestId: "00".repeat(16), outcome: "approved" }),
          ),
        },
        companionToken,
      ),
    );
    expect(r?.status).toBe(403);
    const body = JSON.parse(r!.body as string);
    expect(body.code).toBe("companion-write-not-allowed");
  });

  it("approves a row, then idempotent re-resolve returns alreadyResolved: true", async () => {
    const { handle, mintAndRedeem, writeRequestStore } = await buildHarness();
    const companionToken = await mintAndRedeem("iMac");
    const enqueued = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "x" } }),
          ),
        },
        companionToken,
      ),
    );
    const requestId = JSON.parse(enqueued!.body as string).requestId;

    const r1 = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(JSON.stringify({ requestId, outcome: "approved" })),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r1?.status).toBe(200);
    expect(JSON.parse(r1!.body as string)).toEqual({
      ok: true,
      alreadyResolved: false,
    });

    const persisted = await writeRequestStore.get(requestId);
    expect(persisted?.status).toBe("approved");
    expect(typeof persisted?.resolvedAt).toBe("number");

    // Idempotent re-resolve.
    const r2 = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(JSON.stringify({ requestId, outcome: "approved" })),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r2?.status).toBe(200);
    expect(JSON.parse(r2!.body as string)).toEqual({
      ok: true,
      alreadyResolved: true,
    });
  });

  it("denied outcome works and is reflected in the row", async () => {
    const { handle, mintAndRedeem, writeRequestStore } = await buildHarness();
    const companionToken = await mintAndRedeem("iMac");
    const enqueued = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "x" } }),
          ),
        },
        companionToken,
      ),
    );
    const requestId = JSON.parse(enqueued!.body as string).requestId;

    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(JSON.stringify({ requestId, outcome: "denied" })),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r?.status).toBe(200);
    const persisted = await writeRequestStore.get(requestId);
    expect(persisted?.status).toBe("denied");
  });

  it("404s on a missing requestId", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(
            JSON.stringify({ requestId: "00".repeat(16), outcome: "approved" }),
          ),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r?.status).toBe(404);
  });

  it("400s on bad outcome / missing requestId / empty body", async () => {
    const { handle } = await buildHarness();
    const cases: Array<{ body: Buffer; why: string }> = [
      { body: Buffer.alloc(0), why: "empty" },
      { body: Buffer.from("{}"), why: "no requestId" },
      {
        body: Buffer.from(JSON.stringify({ requestId: "x" })),
        why: "no outcome",
      },
      {
        body: Buffer.from(JSON.stringify({ requestId: "x", outcome: "yolo" })),
        why: "bad outcome",
      },
    ];
    for (const c of cases) {
      const r = await handle(
        withToken(
          {
            method: "POST",
            path: "/api/screens/companion/resolve-pending",
            body: c.body,
          },
          OWNER_TOKEN,
        ),
      );
      expect(r?.status, `expected 400 for ${c.why}`).toBe(400);
    }
  });

  it("503 when companion configured but write-relay store unwired", async () => {
    const { handle } = await buildHarness({ omitWriteRequestStore: true });
    const r = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(JSON.stringify({ requestId: "x", outcome: "approved" })),
        },
        OWNER_TOKEN,
      ),
    );
    expect(r?.status).toBe(503);
  });
});

// =========================================================================
// 4. GET /api/companion/my-pending
// =========================================================================

describe("GET /api/companion/my-pending", () => {
  it("companion-gated (owner → 401)", async () => {
    const { handle } = await buildHarness();
    const r = await handle(
      withToken({ method: "GET", path: "/api/companion/my-pending" }, OWNER_TOKEN),
    );
    expect(r?.status).toBe(401);
  });

  it("401 with no token", async () => {
    const { handle } = await buildHarness();
    const r = await handle(req({ method: "GET", path: "/api/companion/my-pending" }));
    expect(r?.status).toBe(401);
  });

  it("only returns rows that companion submitted (token-prefix filter)", async () => {
    const { handle, mintAndRedeem } = await buildHarness();
    const tA = await mintAndRedeem("iMac-A");
    const tB = await mintAndRedeem("iMac-B");

    const eA = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "a" } }),
          ),
        },
        tA,
      ),
    );
    const idA = JSON.parse(eA!.body as string).requestId;
    const eB = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "revoke-server", intent: { serverName: "b" } }),
          ),
        },
        tB,
      ),
    );
    const idB = JSON.parse(eB!.body as string).requestId;

    const myA = await handle(
      withToken({ method: "GET", path: "/api/companion/my-pending" }, tA),
    );
    expect(myA?.status).toBe(200);
    const bodyA = JSON.parse(myA!.body as string);
    expect(bodyA.pending).toHaveLength(1);
    expect(bodyA.pending[0].requestId).toBe(idA);
    expect(bodyA.pending[0].status).toBe("pending");

    const myB = await handle(
      withToken({ method: "GET", path: "/api/companion/my-pending" }, tB),
    );
    const bodyB = JSON.parse(myB!.body as string);
    expect(bodyB.pending).toHaveLength(1);
    expect(bodyB.pending[0].requestId).toBe(idB);
  });

  it("surfaces approved / denied status transitions and resolvedAt", async () => {
    let nowMs = 1_000_000;
    const { handle, mintAndRedeem, setNow } = await buildHarness({
      initialNow: nowMs,
    });
    const tA = await mintAndRedeem("iMac");
    const eA = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "a" } }),
          ),
        },
        tA,
      ),
    );
    const idA = JSON.parse(eA!.body as string).requestId;
    const eA2 = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "revoke-server", intent: { serverName: "b" } }),
          ),
        },
        tA,
      ),
    );
    const idA2 = JSON.parse(eA2!.body as string).requestId;

    nowMs = 1_000_500;
    setNow(nowMs);
    // Approve A, deny A2.
    await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(JSON.stringify({ requestId: idA, outcome: "approved" })),
        },
        OWNER_TOKEN,
      ),
    );
    await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(JSON.stringify({ requestId: idA2, outcome: "denied" })),
        },
        OWNER_TOKEN,
      ),
    );

    const my = await handle(
      withToken({ method: "GET", path: "/api/companion/my-pending" }, tA),
    );
    const body = JSON.parse(my!.body as string);
    expect(body.pending).toHaveLength(2);
    // Oldest-first.
    expect(body.pending[0].requestId).toBe(idA);
    expect(body.pending[0].status).toBe("approved");
    expect(body.pending[0].resolvedAt).toBe(1_000_500);
    expect(body.pending[1].status).toBe("denied");
    expect(body.pending[1].resolvedAt).toBe(1_000_500);
  });

  it("503 when companion configured but write-relay store unwired", async () => {
    const { handle, pairedSessions } = await buildHarness({
      omitWriteRequestStore: true,
    });
    // Need a companion token; mint+redeem flow uses the same harness'
    // companion deps which are wired — but writeRequestStore is absent.
    // To get a companion token here we have to mint via the existing
    // companion endpoints, which DO work without writeRequestStore.
    void pairedSessions;
    const mintR = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/mint-ticket",
          body: Buffer.from(JSON.stringify({ label: "iMac" })),
        },
        OWNER_TOKEN,
      ),
    );
    const mint = JSON.parse(mintR!.body as string);
    const redeemR = await handle(
      req({
        method: "POST",
        path: "/api/companion/redeem",
        body: Buffer.from(
          JSON.stringify({
            ticketId: mint.ticketId,
            ticketSecret: mint.ticketSecret,
          }),
        ),
      }),
    );
    const companionToken = JSON.parse(redeemR!.body as string).companionSessionToken;
    const r = await handle(
      withToken(
        { method: "GET", path: "/api/companion/my-pending" },
        companionToken,
      ),
    );
    expect(r?.status).toBe(503);
  });
});

// =========================================================================
// 5. Expiry sweep
// =========================================================================

describe("Companion write-request expiry", () => {
  it("a 10-min-old pending row reports status: 'expired' on my-pending", async () => {
    let nowMs = 1_000_000;
    const { handle, mintAndRedeem, setNow } = await buildHarness({
      initialNow: nowMs,
    });
    const t = await mintAndRedeem("iMac");
    const enqueued = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "a" } }),
          ),
        },
        t,
      ),
    );
    const requestId = JSON.parse(enqueued!.body as string).requestId;

    // Advance past the 10-min TTL but still within the companion
    // session's 4-hour TTL.
    nowMs = 1_000_000 + 10 * 60_000 + 1;
    setNow(nowMs);

    const my = await handle(
      withToken({ method: "GET", path: "/api/companion/my-pending" }, t),
    );
    expect(my?.status).toBe(200);
    const body = JSON.parse(my!.body as string);
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].requestId).toBe(requestId);
    expect(body.pending[0].status).toBe("expired");
  });

  it("an APPROVED row past TTL still surfaces as 'approved' (resolved is sticky)", async () => {
    let nowMs = 1_000_000;
    const { handle, mintAndRedeem, setNow } = await buildHarness({
      initialNow: nowMs,
    });
    const t = await mintAndRedeem("iMac");
    const enqueued = await handle(
      withToken(
        {
          method: "POST",
          path: "/api/companion/request-write",
          body: Buffer.from(
            JSON.stringify({ kind: "release-server", intent: { serverName: "a" } }),
          ),
        },
        t,
      ),
    );
    const requestId = JSON.parse(enqueued!.body as string).requestId;

    await handle(
      withToken(
        {
          method: "POST",
          path: "/api/screens/companion/resolve-pending",
          body: Buffer.from(JSON.stringify({ requestId, outcome: "approved" })),
        },
        OWNER_TOKEN,
      ),
    );

    // Push past TTL.
    nowMs = 1_000_000 + 10 * 60_000 + 1;
    setNow(nowMs);
    const my = await handle(
      withToken({ method: "GET", path: "/api/companion/my-pending" }, t),
    );
    const body = JSON.parse(my!.body as string);
    expect(body.pending[0].status).toBe("approved");
  });
});

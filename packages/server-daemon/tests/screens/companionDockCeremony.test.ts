import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCompanionDockRequestStore } from "../../src/companion/companionDockRequestStore.js";
import { InMemoryCompanionTicketStore } from "../../src/companion/companionTicketStore.js";
import { FilePairedSessionStore, defaultPairedSessionPath } from "../../src/pairedSessionStore.js";
import type { HttpRequest } from "../../src/runtime.js";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";

const OWNER_TOKEN = "owner-token-aaaaaaaaaaaaaaaa";
const POLL_SECRET = "11".repeat(32);

function request(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
}

async function harness(now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "companion-dock-ceremony-"));
  const pairedSessions = new FilePairedSessionStore(defaultPairedSessionPath(dir));
  pairedSessions.now = now;
  await pairedSessions.add(OWNER_TOKEN, "phone", now());
  const dockRequestStore = new InMemoryCompanionDockRequestStore();
  const handle = buildScreensHttp({
    gate: pairedSessions,
    serverFqdn: "home.alice.flagship.services",
    username: "alice",
    daemonVersion: "test",
    startedAt: 0,
    now,
    pairedSessions,
    companion: {
      ticketStore: new InMemoryCompanionTicketStore(),
      dockRequestStore,
      pairedSessions,
      serverFqdn: "home.alice.flagship.services",
      username: "alice",
      now,
    },
  });
  return { handle, pairedSessions, dockRequestStore };
}

async function begin(handle: Awaited<ReturnType<typeof harness>>["handle"]) {
  const response = await handle(request({
    method: "POST",
    path: "/api/companion/dock/begin",
    headers: { "user-agent": "Dock Browser" },
    body: Buffer.from(JSON.stringify({ pollSecret: POLL_SECRET })),
  }));
  expect(response?.status).toBe(200);
  return JSON.parse(response!.body as string);
}

describe("desktop-initiated companion dock ceremony", () => {
  it("begins publicly but stores only secret hashes", async () => {
    const { handle, dockRequestStore } = await harness(() => 10_000);
    const started = await begin(handle);
    expect(started.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(started.approvalSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(started.expiresAt).toBe(70_000);
    expect(started.podBaseUrl).toBe("https://home.alice.flagship.services");
    const row = dockRequestStore._all()[0]!;
    expect(row.pollSecretHash).not.toBe(POLL_SECRET);
    expect(row.approvalSecretHash).not.toBe(started.approvalSecret);
    expect(row.userAgent).toBe("Dock Browser");
  });

  it("requires owner authentication to approve", async () => {
    const { handle } = await harness(() => 10_000);
    const started = await begin(handle);
    const response = await handle(request({
      method: "POST",
      path: "/api/screens/companion/dock/approve",
      body: Buffer.from(JSON.stringify({
        requestId: started.requestId,
        approvalSecret: started.approvalSecret,
      })),
    }));
    expect(response?.status).toBe(401);
  });

  it("approves on the phone and delivers the keyless session only to the polling browser", async () => {
    const { handle, pairedSessions } = await harness(() => 10_000);
    const started = await begin(handle);

    const pending = await handle(request({
      method: "POST",
      path: "/api/companion/dock/poll",
      body: Buffer.from(JSON.stringify({ requestId: started.requestId, pollSecret: POLL_SECRET })),
    }));
    expect(pending?.status).toBe(202);

    const qrCannotPoll = await handle(request({
      method: "POST",
      path: "/api/companion/dock/poll",
      body: Buffer.from(JSON.stringify({
        requestId: started.requestId,
        pollSecret: started.approvalSecret,
      })),
    }));
    expect(qrCannotPoll?.status).toBe(401);

    const approved = await handle(request({
      method: "POST",
      path: "/api/screens/companion/dock/approve",
      headers: { "x-flagship-session": OWNER_TOKEN },
      body: Buffer.from(JSON.stringify({
        requestId: started.requestId,
        approvalSecret: started.approvalSecret,
      })),
    }));
    expect(approved?.status).toBe(200);

    const delivered = await handle(request({
      method: "POST",
      path: "/api/companion/dock/poll",
      body: Buffer.from(JSON.stringify({ requestId: started.requestId, pollSecret: POLL_SECRET })),
    }));
    expect(delivered?.status).toBe(200);
    const body = JSON.parse(delivered!.body as string);
    expect(body.status).toBe("approved");
    expect(body.companionSessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(pairedSessions.get(body.companionSessionToken)?.companion).toBe(true);
  });

  it("expires unanswered requests", async () => {
    let nowMs = 10_000;
    const { handle } = await harness(() => nowMs);
    const started = await begin(handle);
    nowMs = started.expiresAt + 1;
    const response = await handle(request({
      method: "POST",
      path: "/api/companion/dock/poll",
      body: Buffer.from(JSON.stringify({ requestId: started.requestId, pollSecret: POLL_SECRET })),
    }));
    expect(response?.status).toBe(410);
  });
});

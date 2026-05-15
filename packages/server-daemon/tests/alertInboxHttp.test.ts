/**
 * Tests for the phone-pollable AlertInbox HTTP surface.
 *
 * Covers:
 *   - GET /api/phone/alerts requires + verifies paired-session token.
 *   - POST /api/phone/alerts/ack requires + verifies paired-session token.
 *   - GET drains in-order; ?since=<id> filters for incremental polling.
 *   - ack(throughId) removes events ≤ throughId.
 *   - Non-matching paths return null (so the runtime falls through).
 */

import { describe, expect, it } from "vitest";
import { InMemoryAlertInbox } from "../src/alertInbox.js";
import {
  TokenSetSessionGate,
  buildAlertInboxHandlers,
} from "../src/alertInboxHttp.js";
import type { HttpRequest } from "../src/runtime.js";

function req(args: {
  method: string;
  path: string;
  token?: string;
  body?: object;
}): HttpRequest {
  const headers: Record<string, string> = {};
  if (args.token) headers["authorization"] = `Flagship-Session ${args.token}`;
  return {
    method: args.method,
    path: args.path,
    headers,
    body: args.body ? Buffer.from(JSON.stringify(args.body)) : Buffer.alloc(0),
  };
}

describe("AlertInbox HTTP — paired-session gate", () => {
  it("GET /api/phone/alerts without auth returns 401", async () => {
    const inbox = new InMemoryAlertInbox();
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    const r = await handle(req({ method: "GET", path: "/api/phone/alerts" }));
    expect(r?.status).toBe(401);
    expect(r?.body.toString()).toContain("missing or malformed");
  });

  it("GET /api/phone/alerts with wrong token returns 401", async () => {
    const inbox = new InMemoryAlertInbox();
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    const r = await handle(
      req({ method: "GET", path: "/api/phone/alerts", token: "wrong" }),
    );
    expect(r?.status).toBe(401);
    expect(r?.body.toString()).toContain("invalid paired-session token");
  });

  it("POST /api/phone/alerts/ack also requires auth", async () => {
    const inbox = new InMemoryAlertInbox();
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    const r = await handle(
      req({ method: "POST", path: "/api/phone/alerts/ack", body: { throughId: 1 } }),
    );
    expect(r?.status).toBe(401);
  });
});

describe("AlertInbox HTTP — drain + ack", () => {
  it("GET drains all events in id order", async () => {
    const inbox = new InMemoryAlertInbox();
    inbox.emit({
      kind: "manual-pending",
      appId: "alice-game1",
      fromCommit: "a",
      toCommit: "b",
    });
    inbox.emit({
      kind: "manual-pending",
      appId: "alice-game2",
      fromCommit: "c",
      toCommit: "d",
    });
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    const r = await handle(
      req({ method: "GET", path: "/api/phone/alerts", token: "secret" }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body.toString());
    expect(body.events).toHaveLength(2);
    expect(body.events[0].id).toBeLessThan(body.events[1].id);
  });

  it("?since=<id> filters for incremental polling", async () => {
    const inbox = new InMemoryAlertInbox();
    const id1 = inbox.emit({
      kind: "manual-pending",
      appId: "a-1",
      fromCommit: "a",
      toCommit: "b",
    });
    inbox.emit({
      kind: "manual-pending",
      appId: "a-2",
      fromCommit: "c",
      toCommit: "d",
    });
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    const r = await handle(
      req({
        method: "GET",
        path: `/api/phone/alerts?since=${id1}`,
        token: "secret",
      }),
    );
    const body = JSON.parse(r!.body.toString());
    expect(body.events).toHaveLength(1);
    expect(body.events[0].alert.appId).toBe("a-2");
  });

  it("POST /ack removes events through the given id", async () => {
    const inbox = new InMemoryAlertInbox();
    const id1 = inbox.emit({
      kind: "manual-pending",
      appId: "a-1",
      fromCommit: "a",
      toCommit: "b",
    });
    inbox.emit({
      kind: "manual-pending",
      appId: "a-2",
      fromCommit: "c",
      toCommit: "d",
    });
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    await handle(
      req({
        method: "POST",
        path: "/api/phone/alerts/ack",
        token: "secret",
        body: { throughId: id1 },
      }),
    );
    expect(inbox.size()).toBe(1);
  });

  it("POST /ack with malformed throughId returns 400", async () => {
    const inbox = new InMemoryAlertInbox();
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/phone/alerts/ack",
        token: "secret",
        body: { throughId: "not-a-number" },
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("non-matching paths return null", async () => {
    const inbox = new InMemoryAlertInbox();
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAlertInboxHandlers({ inbox, gate });
    const r = await handle(
      req({ method: "GET", path: "/api/health", token: "secret" }),
    );
    expect(r).toBeNull();
  });
});

describe("TokenSetSessionGate", () => {
  it("add / remove / has", () => {
    const gate = new TokenSetSessionGate(new Set());
    expect(gate.has("a")).toBe(false);
    gate.add("a");
    expect(gate.has("a")).toBe(true);
    gate.remove("a");
    expect(gate.has("a")).toBe(false);
  });
});

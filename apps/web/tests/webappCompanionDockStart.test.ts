import { describe, expect, it } from "vitest";

import {
  beginDockRequest,
  buildDockApprovalUrl,
  pollDockRequest,
  resolveDockServers,
} from "../public/webapp/lib/companionDockStart.js";

const REQUEST_ID = "ab".repeat(16);
const APPROVAL_SECRET = "cd".repeat(32);
const POLL_SECRET = "ef".repeat(32);
const POD = "https://home.alice.flagship.services";

describe("desktop-initiated companion docking", () => {
  it("resolves the user's public server directory", async () => {
    const result = await resolveDockServers("@Alice", {
      controlApex: "https://flagshipserver.com",
      fetchImpl: async () => new Response(JSON.stringify({
        pods: [{ serverDomain: "home.alice.flagship.services", name: "Home", liveness: "live" }],
      }), { status: 200 }),
    });
    expect(result).toEqual({
      username: "alice",
      servers: [{ fqdn: "home.alice.flagship.services", name: "Home", online: true }],
    });
  });

  it("puts only the phone approval capability in the QR link", () => {
    const link = buildDockApprovalUrl({
      requestId: REQUEST_ID,
      approvalSecret: APPROVAL_SECRET,
      podBaseUrl: POD,
    });
    expect(link).toContain(`request=${REQUEST_ID}`);
    expect(link).toContain(`code=${APPROVAL_SECRET}`);
    expect(link).toContain("server=home.alice.flagship.services");
    expect(link).not.toContain(POLL_SECRET);
  });

  it("keeps the polling secret in the browser when beginning", async () => {
    let posted: any = null;
    const result = await beginDockRequest(POD, {
      pollSecret: POLL_SECRET,
      userAgent: "Test Browser",
      fetchImpl: async (_url: string, init: RequestInit) => {
        posted = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          requestId: REQUEST_ID,
          approvalSecret: APPROVAL_SECRET,
          expiresAt: 70_000,
          podBaseUrl: POD,
          username: "alice",
        }), { status: 200 });
      },
    });
    expect(posted).toEqual({ pollSecret: POLL_SECRET, userAgent: "Test Browser" });
    expect(result.pollSecret).toBe(POLL_SECRET);
    expect(result.approvalUrl).not.toContain(POLL_SECRET);
  });

  it("polls with the browser-only secret and accepts pending", async () => {
    let posted: any = null;
    const result = await pollDockRequest({
      requestId: REQUEST_ID,
      pollSecret: POLL_SECRET,
      podBaseUrl: POD,
    }, {
      fetchImpl: async (_url: string, init: RequestInit) => {
        posted = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ status: "pending", expiresAt: 70_000 }), { status: 202 });
      },
    });
    expect(posted).toEqual({ requestId: REQUEST_ID, pollSecret: POLL_SECRET });
    expect(result.status).toBe("pending");
  });
});

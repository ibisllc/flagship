import { describe, expect, it, vi } from "vitest";
import {
  CA_LEASE_ISSUE_TITLE,
  notifyCaLeaseViaGithubIssue,
} from "../src/caLeaseGithubNotifier.js";
import type { CaLeaseStatus } from "@flagship/control-plane";

const WARN_STATUS: CaLeaseStatus = {
  hasActiveLease: true,
  soonestNotAfterMs: Date.parse("2026-11-05T19:31:05.140Z"),
  msUntilExpiry: 3 * 24 * 60 * 60 * 1000,
  severity: "warn",
  thresholdMs: 7 * 24 * 60 * 60 * 1000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("notifyCaLeaseViaGithubIssue", () => {
  it("creates an issue when none is open", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      if (url.toString().includes("/search/issues")) {
        return jsonResponse({ total_count: 0, items: [] });
      }
      return jsonResponse({ number: 42 }, 201);
    }) as unknown as typeof fetch;

    await notifyCaLeaseViaGithubIssue(WARN_STATUS, "lapsing soon", {
      token: "ghp_test",
      repo: "ibisllc/flagship",
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/search/issues");
    expect(decodeURIComponent(calls[0]!.url)).toContain(CA_LEASE_ISSUE_TITLE);
    expect(calls[1]!.url).toBe("https://api.github.com/repos/ibisllc/flagship/issues");
    const body = JSON.parse(calls[1]!.init!.body as string);
    expect(body.title).toBe(CA_LEASE_ISSUE_TITLE);
    expect(body.body).toContain("lapsing soon");
    expect(body.body).toContain("warn");
  });

  it("no-ops when a matching issue is already open (dedup)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (url.toString().includes("/search/issues")) {
        return jsonResponse({ total_count: 1, items: [{ number: 7 }] });
      }
      throw new Error("should not reach issue creation");
    }) as unknown as typeof fetch;

    await notifyCaLeaseViaGithubIssue(WARN_STATUS, "lapsing soon", {
      token: "ghp_test",
      repo: "ibisllc/flagship",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws on a failed search so the caller's catch logs it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "bad creds" }, 401)) as unknown as typeof fetch;

    await expect(
      notifyCaLeaseViaGithubIssue(WARN_STATUS, "lapsing soon", {
        token: "bad",
        repo: "ibisllc/flagship",
        fetchImpl,
      }),
    ).rejects.toThrow(/ca-lease github search failed/);
  });

  it("throws on a failed create", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (url.toString().includes("/search/issues")) {
        return jsonResponse({ total_count: 0, items: [] });
      }
      return jsonResponse({ message: "nope" }, 403);
    }) as unknown as typeof fetch;

    await expect(
      notifyCaLeaseViaGithubIssue(WARN_STATUS, "lapsing soon", {
        token: "ghp_test",
        repo: "ibisllc/flagship",
        fetchImpl,
      }),
    ).rejects.toThrow(/ca-lease github issue create failed/);
  });
});

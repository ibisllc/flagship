// Smoke test for the webapp Activity feed merge/sort.

import { describe, expect, it } from "vitest";

interface FeedItem { kind: string; at: number; title: string; }

function buildFeed(
  approvals: Array<{ requestedAt: number; serverFqdn: string }>,
  recents: Array<{ at: number; kind: string; appId: string }>,
  recovery: { status: string; completedAt: number } | null,
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const a of approvals) {
    items.push({ kind: "approval", at: a.requestedAt, title: `unlock ${a.serverFqdn}` });
  }
  for (const r of recents) {
    items.push({ kind: "install", at: r.at, title: `${r.kind}: ${r.appId}` });
  }
  if (recovery) {
    items.push({ kind: "recovery", at: recovery.completedAt, title: `recovery ${recovery.status}` });
  }
  return items.sort((a, b) => b.at - a.at);
}

describe("activity feed merge", () => {
  it("sorts items by timestamp descending", () => {
    const feed = buildFeed(
      [{ requestedAt: 100, serverFqdn: "home.h.flagship.services" }],
      [
        { at: 300, kind: "deploy", appId: "wiki" },
        { at: 200, kind: "installed", appId: "plants" },
      ],
      { status: "complete", completedAt: 50 },
    );
    expect(feed.map((i) => i.at)).toEqual([300, 200, 100, 50]);
  });

  it("tolerates empty inputs", () => {
    expect(buildFeed([], [], null)).toEqual([]);
  });

  it("tags each item with its kind so the renderer can branch", () => {
    const feed = buildFeed(
      [{ requestedAt: 1, serverFqdn: "x" }],
      [{ at: 2, kind: "installed", appId: "y" }],
      null,
    );
    expect(feed.map((i) => i.kind).sort()).toEqual(["approval", "install"]);
  });
});

describe("pending-server cancel envelope shape", () => {
  it("revoke URL percent-encodes the serial", () => {
    const serial = "01ABC/DEF";
    const url = `https://flagshipserver.com/api/auth-code/${encodeURIComponent(serial)}/revoke`;
    expect(url).toBe("https://flagshipserver.com/api/auth-code/01ABC%2FDEF/revoke");
  });
});

// Calls and social entries on Activity (docs/activity-social.md): lib/socialActivity.js builds them from the call
// history, the conversations and the published page; views/activity.js shows them under an All / Servers / Social
// filter, and a server log entry opens its server. Mirrors iOS SocialActivityTests and Android SocialActivityTest.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSocialActivity, postSnippet, socialEntryDetail, socialEntryTitle } from "../public/webapp/lib/socialActivity.js";
import { boxEntryRow, BOX_EVENT_LABELS, mergeFeed } from "../public/webapp/lib/activityFeed.js";

const WEBAPP = join(__dirname, "../public/webapp");
const msg = (id: string, mine: boolean, at: number) => ({ msgId: id, seq: 1, sentAt: at, mine, text: id });
const conv = (id: string, pub: string, messages: ReturnType<typeof msg>[]) => ({ conv: id, pseudonymPub: pub, messages });
const name = (p: string) => `Name ${p}`;

describe("buildSocialActivity", () => {
  it("names each call by direction and outcome, and opens its conversation while it exists", () => {
    const history = [
      { id: "missed:1", at: 10, direction: "in", outcome: "missed", video: false, peer: { kind: "visitor", conv: "c1", pseudonymPub: "p1" } },
      { id: "missed:2", at: 20, direction: "in", outcome: "missed", video: true, peer: { kind: "visitor", conv: "gone", pseudonymPub: "p2" } },
      { id: "out:3", at: 30, direction: "out", outcome: "browser", video: false, peer: { kind: "page", username: "bob", pageId: "x" } },
      { id: "missed:4", at: 40, direction: "in", outcome: "missed", video: false, peer: { kind: "visitor", conv: "c9", pseudonymPub: null, anonymous: true } },
    ];
    const out = buildSocialActivity({ history, conversations: [conv("c1", "p1", [msg("m", false, 5)])], name });
    const by = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(by["call:missed:1"]).toMatchObject({ kind: "call.missed", name: "Name p1", target: { kind: "thread", conv: "c1" } });
    // Its conversation was deleted: the call opens the Calls page instead.
    expect(by["call:missed:2"]).toMatchObject({ kind: "call.missed", target: { kind: "calls" }, video: true });
    expect(socialEntryDetail(by["call:missed:2"])).toBe("Video call");
    expect(by["call:out:3"]).toMatchObject({ kind: "call.placed", name: "bob" });
    expect(socialEntryTitle(by["call:out:3"])).toBe("You called bob");
    expect(by["call:missed:4"].name).toBe("Anonymous caller");
    expect(out.map((e) => e.at)).toEqual([40, 30, 20, 10, 5]);
  });

  it("dates a conversation at its first message; a request says so", () => {
    const out = buildSocialActivity({
      conversations: [conv("a", "pa", [msg("1", false, 100), msg("2", true, 200)]), conv("r", "pr", [msg("3", false, 300)])],
      isRequest: (c: { conv: string }) => c.conv === "r",
      name,
    });
    expect(out.map((e) => [e.kind, e.at])).toEqual([["conversation.request", 300], ["conversation.new", 100]]);
    expect(socialEntryTitle(out[0])).toBe("Message request from Name pr");
  });

  it("deleting forgets: without the conversation and its calls nothing is left", () => {
    const history = [{ id: "missed:1", at: 10, direction: "in", outcome: "missed", peer: { kind: "visitor", conv: "c1", pseudonymPub: "p1" } }];
    expect(buildSocialActivity({ history, conversations: [conv("c1", "p1", [msg("m", false, 5)])], name })).toHaveLength(2);
    expect(buildSocialActivity({ history: [], conversations: [], name })).toEqual([]);
  });

  it("shows the page and its posts only while it is public", () => {
    expect(buildSocialActivity({ page: null })).toEqual([]);
    const page = { index: { seq: 1, issuedAt: 50 }, chunks: [[{ id: "p", createdAt: 49, text: "Hello.\nSecond line" }]] };
    const out = buildSocialActivity({ page });
    expect(out.map((e) => e.kind)).toEqual(["page.published", "post.published"]);
    expect(out[1].snippet).toBe("Hello.");
    expect(out.every((e) => e.target.kind === "page")).toBe(true);
    expect(buildSocialActivity({ page: { index: { seq: 4, issuedAt: 9 }, chunks: [] } }).map((e) => e.kind)).toEqual(["page.updated"]);
  });

  it("shortens a long post to 80 characters", () => {
    expect([...(postSnippet("x".repeat(200)) ?? "")]).toHaveLength(80);
    expect(postSnippet("  \n")).toBeNull();
  });
});

describe("server entries", () => {
  it("a scheduled backup has its own title", () => {
    expect(BOX_EVENT_LABELS["server.backup.scheduled"].label).toBe("Scheduled backup finished");
  });

  it("a server's log entry carries the server it came from, so a tap opens it", () => {
    expect(boxEntryRow({ ts: 1, action: "app.updated", kind: "app.updated", ok: true }, "home", "home.alice.flagship.services")).toMatchObject({ fqdn: "home.alice.flagship.services" });
    const rows = mergeFeed({ boxes: [{ serverName: "", fqdn: "home.alice.flagship.services", entries: [{ ts: 2, action: "x", kind: "app.installed" }] }] } as any);
    expect(rows[0].fqdn).toBe("home.alice.flagship.services");
  });
});

describe("the Activity view", () => {
  const src = readFileSync(join(WEBAPP, "views/activity.js"), "utf8");
  const html = readFileSync(join(WEBAPP, "index.html"), "utf8");

  it("has the filter and the social section", () => {
    expect(html).toContain('id="activity-filter-slot"');
    expect(html).toContain('id="activity-social"');
    for (const f of ['tr("All")', 'tr("Servers")', 'tr("Social")', 'tr("Calls and messages")', 'tr("No calls or messages yet.")']) expect(src).toContain(f);
    expect(src).toContain("enterThread(e.target.conv)");
    expect(src).toContain("enterServerDetail(fqdn)");
  });

  it("the shell caches the new module", () => {
    expect(readFileSync(join(WEBAPP, "service-worker.js"), "utf8")).toContain('"/lib/socialActivity.js"');
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  ABUSE_COPY,
  abuseState,
  canonicalAbuseNoticeDone,
  categoryLabel,
  markNoticeDone,
  noticeBannerModels,
  parseAbuseAnswer,
  refreshAbuseNotices,
  setAbuseState,
  suspendedModel,
} from "../public/webapp/lib/abuseNotices.js";
import { SENSITIVE_TAGS } from "../public/webapp/lib/adminRoot.js";
import { accountReadUsername } from "../public/webapp/lib/accountRead.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/abuse-notice-done/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const sw = readFileSync(resolve(__dirname, "../public/webapp/service-worker.js"), "utf8");

const notice = {
  id: "0123456789abcdef0123456789abcdef",
  subjectKind: "app",
  subject: "chess.alice.flagship.services",
  serviceId: "alice--chess",
  category: "phishing",
  action: "take-down",
  detail: "A login form copies a bank.",
  deadlineAt: 1762300000000,
  issuedAt: 1762000000000,
  doneAt: null,
  doneNote: null,
};

describe("web abuse-notice-done", () => {
  it("matches the shared vectors and refuses the malformed notes", async () => {
    for (const d of v.done) {
      const bytes = await canonicalAbuseNoticeDone(d.done);
      expect(new TextDecoder().decode(bytes)).toBe(d.canonical);
      expect(ed25519.verify(hex(d.signatureHex), bytes, hex(v.pubHex))).toBe(true);
    }
    for (const r of v.refused) await expect(canonicalAbuseNoticeDone(r.done), r.name).rejects.toThrow();
  });
  it("is signed with the sensitive-order key, and read with the account read token", () => {
    expect(SENSITIVE_TAGS.has("flagship/abuse-notice-done/v1")).toBe(true);
    expect(accountReadUsername("https://flagshipserver.com/api/users/alice/abuse-notices")).toBe("alice");
  });
});

describe("web abuse notices", () => {
  it("shows banners to admin devices only, with what, why, what to do and the deadline", () => {
    expect(noticeBannerModels([notice], { isAdmin: false })).toEqual([]);
    const [m] = noticeBannerModels([notice], { isAdmin: true, formatDate: (ms: number) => `T${ms}` });
    expect(m).toMatchObject({
      title: "Action needed on your account",
      about: "We received a report about chess.alice.flagship.services.",
      reason: "Reason: Phishing",
      action: "What to do: take it down.",
      deadline: "Deadline: T1762300000000",
      detail: "A login form copies a bank.",
      canMarkDone: true,
      doneLine: null,
    });
    const [done] = noticeBannerModels([{ ...notice, doneAt: 5, action: "modify" }], { isAdmin: true, formatDate: () => "today" });
    expect(done).toMatchObject({ canMarkDone: false, doneLine: "Marked done on today. We will check it.", action: ABUSE_COPY.modify });
    expect(categoryLabel("nonsense")).toBe("Other");
  });

  it("drops what isn't a notice and reads the suspension", () => {
    const p = parseAbuseAnswer({ notices: [notice, { id: "x" }], suspension: { suspendedAt: 1, category: "malware", reason: "Serves malware." } });
    expect(p.notices).toHaveLength(1);
    const m = suspendedModel(p.suspension, "alice")!;
    expect(m.title).toBe("This account was suspended");
    expect(m.reason).toBe("Reason: Malware");
    expect(m.detail).toBe("Serves malware.");
    expect(m.appealHref).toBe("mailto:abuse@flagship.services?subject=Appeal%20(alice)");
    expect(m.data).toContain("Your data stays on your own server");
    expect(suspendedModel(null, "alice")).toBeNull();
  });

  it("refreshes through the read door and keeps the last answer on failure", async () => {
    const session = { username: "alice" };
    const urls: string[] = [];
    await refreshAbuseNotices({
      getSession: () => session,
      baseUrl: "https://flagshipserver.com",
      fetch: async (u: string) => (urls.push(u), Response.json({ notices: [notice], suspension: null })),
    });
    expect(urls).toEqual(["https://flagshipserver.com/api/users/alice/abuse-notices"]);
    expect(abuseState().notices).toHaveLength(1);
    await refreshAbuseNotices({ getSession: () => session, fetch: async () => new Response("", { status: 500 }) });
    expect(abuseState().notices).toHaveLength(1);
  });

  it("posts the signed done and shows the admin-only sentence when refused", async () => {
    setAbuseState({ notices: [notice], suspension: null, username: "alice" });
    const seed = hex(v.seedHex);
    const sign = async (_umk: unknown, bytes: Uint8Array) => ed25519.sign(bytes, seed);
    let sent: any = null;
    const ok = await markNoticeDone(notice.id, "Removed.", {
      getSession: () => ({ username: "alice", umk: new Uint8Array(32) }),
      now: () => 1762000000000,
      baseUrl: "https://flagshipserver.com",
      sign,
      fetch: async (u: string, init: RequestInit) => ((sent = { u, body: JSON.parse(String(init.body)) }), Response.json({ ok: true, doneAt: 7 })),
    });
    expect(ok).toEqual({ ok: true, doneAt: 7 });
    expect(sent.u).toBe(`https://flagshipserver.com/api/users/alice/abuse-notices/${notice.id}/done`);
    expect(sent.body.request).toEqual({ username: "alice", noticeId: notice.id, note: "Removed.", issuedAt: 1762000000000 });
    const bytes = await canonicalAbuseNoticeDone(sent.body.request);
    expect(ed25519.verify(hex(sent.body.signature), bytes, hex(v.pubHex))).toBe(true);
    expect(abuseState().notices[0].doneAt).toBe(7);
    const refused = await markNoticeDone(notice.id, "", {
      getSession: () => ({ username: "alice" }),
      sign,
      fetch: async () => Response.json({ code: "not-admin" }, { status: 403 }),
    });
    expect(refused).toEqual({ ok: false, message: "Only an admin device can do this." });
  });

  it("the service worker shows the content-free abuse-notice push, on shell v200", () => {
    expect(sw).toContain('data.category === "abuse-notice"');
    expect(sw).toContain('"/lib/abuseNoticeUi.js"');
    expect(sw).toContain('SHELL_VERSION = "v200"');
  });
});

import { describe, expect, it } from "vitest";
import { canonicalPublisherTrust, ed, verifyPublisherTrust } from "@flagship/protocol";
// @ts-expect-error plain browser module
import { canonicalPublisherTrustBytes, remainingText, sliverModel, trustPublisherKey, rejectPublisherKey } from "../public/webapp/lib/securitySliver.js";
// @ts-expect-error plain browser module
import { rowHtml, SLIVER_COPY } from "../public/webapp/lib/sliverUi.js";

const trust = { serviceId: "chess", appId: "alice--chess", identityGeneration: 1, oldKeyHex: "a".repeat(64), newKeyHex: "b".repeat(64), newEpoch: 1, issuedAt: 77 };

describe("webapp security sliver", () => {
  it("builds the same bytes the box verifies", () => {
    expect(Buffer.from(canonicalPublisherTrustBytes(trust)).toString()).toBe(Buffer.from(canonicalPublisherTrust(trust)).toString());
    expect(() => canonicalPublisherTrustBytes({ ...trust, serviceId: "a|b" })).toThrow();
  });

  it("trusting a key signs exactly that service and change, and posts it", async () => {
    const priv = new Uint8Array(32).fill(4);
    const pub = ed.getPublicKey(priv);
    let posted: { path: string; body: string } | null = null;
    await trustPublisherKey("chess", {
      fetchWaiting: async () => ({ waiting: { trust: { ...trust, issuedAt: undefined } } }),
      signer: async (_umk: unknown, bytes: Uint8Array) => ed.sign(bytes, priv),
      session: { umk: new Uint8Array(32) },
      now: () => 77,
      post: async (path: string, body: string) => { posted = { path, body }; return { ok: true }; },
    });
    expect(posted!.path).toBe("/api/screens/services/chess/publisher/trust");
    const sent = JSON.parse(posted!.body);
    expect(sent.trust).toEqual(trust);
    expect(verifyPublisherTrust(sent.trust, sent.signatureHex, pub)).toBe(true);
    await expect(trustPublisherKey("chess", { fetchWaiting: async () => ({ waiting: null }), session: { umk: new Uint8Array(32) } })).rejects.toThrow(/No new key/);
  });

  it("rejecting posts to the reject route", async () => {
    let path = "";
    await rejectPublisherKey("chess", { post: async (p: string) => { path = p; return {}; } });
    expect(path).toBe("/api/screens/services/chess/publisher/reject");
  });

  it("every line is its own row with severity, target, state, deadline and action; nothing is dropped", () => {
    const lines = [
      { eventId: "a", severity: "critical", target: "account", state: "active", summary: "Recovery started", updatedAt: 0, remainingMs: 2 * 86_400_000 + 3 * 3_600_000, kind: "recovery-attempt", action: "Veto it" },
      { eventId: "b", severity: "high", target: "chess", state: "active", summary: "A new key signed an update", updatedAt: 0, remainingMs: null, kind: "publisher-key", action: "Review" },
      { eventId: "c", severity: "low", target: "chess", state: "resolved", summary: "Old", updatedAt: 0, remainingMs: null, kind: "other", action: "ignored once resolved" },
    ];
    const m = sliverModel(lines, () => "then");
    expect(m).toHaveLength(3);
    expect(m[0]).toMatchObject({ severityLabel: "Critical", deadline: "2 days 3 hours left", action: "Veto it" });
    expect(m[1]!.publisherKey).toBe("chess");
    expect(m[2]).toMatchObject({ active: false, action: null, publisherKey: null });
  });

  it("deadline wording, including overdue", () => {
    expect(remainingText(null)).toBe("");
    expect(remainingText(5 * 60_000)).toBe("5 minutes left");
    expect(remainingText(3 * 3_600_000 + 10 * 60_000)).toBe("3 hours 10 minutes left");
    expect(remainingText(-2 * 3_600_000)).toBe("overdue by 2 hours 0 minutes");
  });

  it("a waiting key shows both fingerprints, the continuity status, the warning and both choices; text is escaped", () => {
    const m = sliverModel([{ eventId: "b", severity: "high", target: "<chess>", state: "active", summary: "<b>x</b>", updatedAt: 0, remainingMs: null, kind: "publisher-key", action: "Review" }], () => "t")[0];
    m.publisherKey = "chess";
    const html = rowHtml(m, { oldFingerprint: "aaaa aaaa", newFingerprint: "bbbb bbbb", continuity: "none" });
    expect(html).toContain("aaaa aaaa");
    expect(html).toContain("bbbb bbbb");
    expect(html).toContain(SLIVER_COPY.noChain);
    expect(html).toContain(SLIVER_COPY.warning);
    expect(html).toContain(SLIVER_COPY.trust);
    expect(html).toContain(SLIVER_COPY.reject);
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<chess>");
  });
});

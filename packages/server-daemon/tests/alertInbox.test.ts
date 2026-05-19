import { describe, expect, it } from "vitest";
import { InMemoryAlertInbox } from "../src/alertInbox.js";

describe("InMemoryAlertInbox", () => {
  it("emit assigns monotonic ids and list returns events since a cursor", () => {
    const inbox = new InMemoryAlertInbox({ now: () => 1000 });
    const id1 = inbox.emit({
      kind: "lineage-break",
      serviceId: "alice-game1",
      canonicalUrl: "game1.alice.flagship.services",
      lineageAnchor: "anchor",
      upstreamTip: "tipA",
    });
    const id2 = inbox.emit({
      kind: "lineage-break",
      serviceId: "alice-game2",
      canonicalUrl: "game2.alice.flagship.services",
      lineageAnchor: "anchor2",
      upstreamTip: "tipB",
    });
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(inbox.list()).toHaveLength(2);
    expect(inbox.list(1)).toHaveLength(1);
    expect(inbox.list(2)).toHaveLength(0);
  });

  it("dedupes identical lineage-break alerts (same serviceId + upstreamTip)", () => {
    const inbox = new InMemoryAlertInbox();
    inbox.emit({
      kind: "lineage-break",
      serviceId: "alice-game1",
      canonicalUrl: "x",
      lineageAnchor: "a",
      upstreamTip: "tipA",
    });
    const dup = inbox.emit({
      kind: "lineage-break",
      serviceId: "alice-game1",
      canonicalUrl: "x",
      lineageAnchor: "a",
      upstreamTip: "tipA",
    });
    expect(dup).toBeNull();
    expect(inbox.size()).toBe(1);
  });

  it("emits a NEW lineage-break when upstream advances to a different tip", () => {
    const inbox = new InMemoryAlertInbox();
    inbox.emit({
      kind: "lineage-break",
      serviceId: "alice-game1",
      canonicalUrl: "x",
      lineageAnchor: "a",
      upstreamTip: "tipA",
    });
    const id2 = inbox.emit({
      kind: "lineage-break",
      serviceId: "alice-game1",
      canonicalUrl: "x",
      lineageAnchor: "a",
      upstreamTip: "tipB",
    });
    expect(id2).toBe(2);
    expect(inbox.size()).toBe(2);
  });

  it("dedupes manual-pending and migration-failed by salient field", () => {
    const inbox = new InMemoryAlertInbox();
    expect(
      inbox.emit({ kind: "manual-pending", serviceId: "a-b", fromCommit: "x", toCommit: "y" }),
    ).toBe(1);
    expect(
      inbox.emit({ kind: "manual-pending", serviceId: "a-b", fromCommit: "x", toCommit: "y" }),
    ).toBeNull();
    expect(inbox.emit({ kind: "migration-failed", serviceId: "a-b", migrationFile: "0001.sql", reason: "x" })).toBe(2);
    expect(inbox.emit({ kind: "migration-failed", serviceId: "a-b", migrationFile: "0001.sql", reason: "different reason" })).toBeNull();
    expect(inbox.emit({ kind: "migration-failed", serviceId: "a-b", migrationFile: "0002.sql", reason: "x" })).toBe(3);
  });

  it("ack(throughId) drops events with id <= throughId", () => {
    const inbox = new InMemoryAlertInbox();
    const id1 = inbox.emit({ kind: "manual-pending", serviceId: "a-b", fromCommit: "x", toCommit: "y" });
    const id2 = inbox.emit({ kind: "manual-pending", serviceId: "c-d", fromCommit: "x", toCommit: "y" });
    inbox.ack(id1!);
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.list()[0]?.id).toBe(id2);
  });

  it("caps queue at MAX_INBOX, dropping oldest", () => {
    const inbox = new InMemoryAlertInbox();
    for (let i = 0; i < 105; i++) {
      inbox.emit({
        kind: "lineage-break",
        serviceId: `a-${i}`,
        canonicalUrl: "x",
        lineageAnchor: "a",
        upstreamTip: `tip${i}`,
      });
    }
    expect(inbox.size()).toBe(100);
    // Newest survived; oldest was dropped.
    expect(inbox.list().some((e) => e.alert.serviceId === "a-104")).toBe(true);
    expect(inbox.list().some((e) => e.alert.serviceId === "a-0")).toBe(false);
  });

  it("browser-input-needed dedupes by (serviceId, tabId, inputKind)", () => {
    const inbox = new InMemoryAlertInbox();
    const id1 = inbox.emit({
      kind: "browser-input-needed",
      serviceId: "alice-shopper",
      tabId: "tab-1",
      domain: "amazon.com",
      inputKind: "password",
      screenshotRef: "shot-1",
    });
    expect(id1).toBe(1);
    // Same field still focused — re-detection should not flood the phone.
    const dup = inbox.emit({
      kind: "browser-input-needed",
      serviceId: "alice-shopper",
      tabId: "tab-1",
      domain: "amazon.com",
      inputKind: "password",
      screenshotRef: "shot-2",
    });
    expect(dup).toBeNull();
    // Page transitions to OTP step (different inputKind) — new alert is fine.
    const id2 = inbox.emit({
      kind: "browser-input-needed",
      serviceId: "alice-shopper",
      tabId: "tab-1",
      domain: "amazon.com",
      inputKind: "otp",
      screenshotRef: "shot-3",
    });
    expect(id2).toBe(2);
    // Different tab — new alert.
    const id3 = inbox.emit({
      kind: "browser-input-needed",
      serviceId: "alice-shopper",
      tabId: "tab-2",
      domain: "amazon.com",
      inputKind: "password",
      screenshotRef: "shot-4",
    });
    expect(id3).toBe(3);
  });
});

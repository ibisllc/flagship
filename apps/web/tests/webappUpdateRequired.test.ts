/**
 * "This server needs an update" (owner decision 2026-11-02): `/pods` `updateRequired` marks a box from before 0.3
 * (control-plane boxUpdateRequired.ts). Home's row wears a "Needs an update" pill; the server page opens with the
 * banner, naming the day its certificate runs out when `.com` knows it.
 */
import { describe, expect, it } from "vitest";
import { renderServerCard, updateRequiredPillHtml } from "../public/webapp/views/home.js";
import { updateRequiredBannerHtml, updateRequiredDetail } from "../public/webapp/lib/updateRequired.js";

const NOW = Date.now();
const server = { serverId: "home.alice.flagship.services" };
const livePod = (extra: Record<string, unknown> = {}) => ({
  serverDomain: server.serverId,
  lastReported: NOW - 60_000,
  currentCert: { validUntil: NOW + 60 * 86_400_000 },
  ...extra,
});
const ends = Date.UTC(2026, 11, 24, 12);

describe("Home row", () => {
  it("shows the pill for a box that needs an update", () => {
    const html = renderServerCard(server, livePod({ updateRequired: { reason: "box-too-old", certificateExpiresAt: ends } }));
    expect(html).toContain('data-testid="pod-card-update-required"');
    expect(html).toContain("Needs an update");
  });

  it("shows nothing without updateRequired, or for a revoked server", () => {
    expect(renderServerCard(server, livePod())).not.toContain("pod-card-update-required");
    expect(updateRequiredPillHtml({ updateRequired: { reason: "box-too-old", certificateExpiresAt: null }, revokedAt: NOW })).toBe("");
  });
});

describe("server page banner", () => {
  it("names the day the certificate runs out", () => {
    const html = updateRequiredBannerHtml(livePod({ updateRequired: { reason: "box-too-old", certificateExpiresAt: ends } }), "en-US");
    expect(html).toContain("This server needs an update to keep working with Flagship 0.3");
    expect(html.replace(/&#0?39;/g, "'")).toContain("Its certificate can't be renewed and runs out on December 24, 2026. Update it before then.");
  });

  it("says the certificate can't renew when the date is unknown", () => {
    expect(updateRequiredDetail({ reason: "box-too-old", certificateExpiresAt: null })).toBe(
      "Its certificate can't be renewed until it is updated.",
    );
  });

  it("is empty when the box needs no update or is revoked", () => {
    expect(updateRequiredBannerHtml(livePod())).toBe("");
    expect(updateRequiredBannerHtml(livePod({ revokedAt: NOW, updateRequired: { reason: "box-too-old", certificateExpiresAt: ends } }))).toBe("");
  });
});

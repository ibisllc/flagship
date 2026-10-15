// Transfer giver: the offer is shown as a QR (the copy says "scan"), with the
// link text kept below it for pasting, as iOS's TransferGiverScreen shows.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain-JS webapp module, no types
import { renderTransferQr } from "../public/webapp/views/server-detail.js";
// @ts-expect-error — plain-JS webapp module, no types
import { buildTransferLink } from "../public/webapp/lib/serverTransfer.js";
// @ts-expect-error — plain-JS module, no types
import * as qrEncoder from "../public/qrEncoder.js";

const VIEW = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "server-detail.js"), "utf8");

const offer = {
  v: 1,
  kind: "flagship-transfer-offer",
  serverDomain: "kitchen.plucky-avocet.flagship.services",
  transferNonce: "ab".repeat(32),
  giverIrkPub: "cd".repeat(32),
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_900_000,
  offerSignature: "ef".repeat(64),
};

describe("transfer giver — the offer as a QR", () => {
  it("renders a real offer link (beyond the old version-10 limit) as an SVG", async () => {
    const link: string = buildTransferLink(offer, { baseUrl: "https://flagshipserver.com" });
    expect(new TextEncoder().encode(link).length).toBeGreaterThan(274);
    const slot = { innerHTML: "" };
    await renderTransferQr(slot, link, async () => qrEncoder);
    expect(slot.innerHTML.startsWith("<svg")).toBe(true);
    expect(slot.innerHTML).toContain('aria-label="QR code"');
  });

  it("leaves the slot empty when the encoder can't load (the link text still shows)", async () => {
    const slot = { innerHTML: "stale" };
    await renderTransferQr(slot, "https://x/transfer?o=y", async () => {
      throw new Error("offline");
    });
    expect(slot.innerHTML).toBe("");
  });

  it("the dialog shows the QR above the paste-able link", () => {
    const qr = VIEW.indexOf('id="transfer-qr" data-transfer-qr-svg');
    const text = VIEW.indexOf("readonly data-transfer-qr>");
    expect(qr).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(qr);
    expect(VIEW).toContain('renderTransferQr(dlg.querySelector("[data-transfer-qr-svg]"), link)');
  });
});

import { describe, expect, it } from "vitest";
import { canonicalDaemonStatusReport, ed, signDaemonStatusReport } from "@flagship/protocol";

const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

import { canonicalDaemonStatus, verifyDaemonStatus } from "../src/lib/daemonStatus.js";
import { acceptEvidence, boxFor, checkPin, finalAction, isFlagshipHost, needsRefresh, normalizeFingerprint } from "../src/lib/pinCheck.js";

const DOMAIN = "home.alice.flagship.services";
const CERT = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const stk = ed.utils.randomPrivateKey();
const stkPubHex = bytesToHex(ed.getPublicKey(stk));

function box(evidence: { certSha256: string; issuedAt: number } | null = { certSha256: CERT, issuedAt: NOW - DAY }) {
  return {
    serverDomain: DOMAIN,
    username: "alice",
    stkPubHex,
    token: "11".repeat(32),
    tokenExpiresAt: NOW + 30 * DAY,
    pairedAt: NOW - 2 * DAY,
    session: "active",
    evidence: evidence ? { ...evidence, certValidUntil: NOW + 60 * DAY } : null,
  };
}

function signed(over: Partial<{ serverDomain: string; certSha256: string | null; issuedAt: number }> = {}, key = stk) {
  const report = {
    serverDomain: DOMAIN,
    certSha256: CERT,
    certValidUntil: NOW + 60 * DAY,
    certIssuer: "Let's Encrypt R11",
    appsServed: [] as string[],
    nonce: "00112233445566778899aabbccddeeff",
    issuedAt: NOW,
    ...over,
  };
  return { report, signatureHex: bytesToHex(signDaemonStatusReport(report, (m: Uint8Array) => ed.sign(m, key))) };
}

describe("daemon-status bytes", () => {
  it("match @flagship/protocol byte for byte, apps sorted, nulls empty", () => {
    const r = {
      serverDomain: DOMAIN, certSha256: null, certValidUntil: null, certIssuer: null,
      appsServed: ["zeta", "alpha"], nonce: "n1", issuedAt: 42,
    };
    expect(Buffer.from(canonicalDaemonStatus(r))).toEqual(Buffer.from(canonicalDaemonStatusReport(r)));
    const full = signed().report;
    expect(Buffer.from(canonicalDaemonStatus(full))).toEqual(Buffer.from(canonicalDaemonStatusReport(full)));
  });

  it("refuses a field carrying the separator", () => {
    expect(() => canonicalDaemonStatus({ ...signed().report, certIssuer: "a|b" })).toThrow();
  });

  it("verifies the box's signature and nothing else", async () => {
    const { report, signatureHex } = signed();
    expect(await verifyDaemonStatus(report, signatureHex, stkPubHex)).toBe(true);
    expect(await verifyDaemonStatus({ ...report, certSha256: OTHER }, signatureHex, stkPubHex)).toBe(false);
    const other = bytesToHex(ed.getPublicKey(ed.utils.randomPrivateKey()));
    expect(await verifyDaemonStatus(report, signatureHex, other)).toBe(false);
    expect(await verifyDaemonStatus(report, "zz", stkPubHex)).toBe(false);
  });
});

describe("names", () => {
  it("looks only at Flagship names", () => {
    expect(isFlagshipHost(DOMAIN)).toBe(true);
    expect(isFlagshipHost("notes.home.alice.flagship.services.")).toBe(true);
    expect(isFlagshipHost("chess.fshp.app")).toBe(true);
    expect(isFlagshipHost("flagship.services")).toBe(false);
    expect(isFlagshipHost("evilflagship.services")).toBe(false);
    expect(isFlagshipHost("example.com")).toBe(false);
  });

  it("matches a box by whole labels, the longest box winning", () => {
    const boxes = { [DOMAIN]: box() };
    expect(boxFor(DOMAIN, boxes)?.serverDomain).toBe(DOMAIN);
    expect(boxFor(`notes.${DOMAIN}`, boxes)?.serverDomain).toBe(DOMAIN);
    expect(boxFor("evilhome.alice.flagship.services", boxes)).toBeNull();
    expect(boxFor("home.alice.flagship.services.evil.flagship.services", boxes)).toBeNull();
  });

  it("normalizes Firefox's colon fingerprints", () => {
    const colon = CERT.toUpperCase().match(/.{2}/g)!.join(":");
    expect(normalizeFingerprint(colon)).toBe(CERT);
    expect(normalizeFingerprint("abc")).toBeNull();
  });
});

describe("checkPin", () => {
  const boxes = { [DOMAIN]: box() };

  it("matches the signed leaf on the box and every name under it", () => {
    expect(checkPin({ host: DOMAIN, servedSha256: CERT, boxes, now: NOW }).verdict).toBe("match");
    expect(checkPin({ host: `notes.${DOMAIN}`, servedSha256: CERT, boxes, now: NOW }).verdict).toBe("match");
  });

  it("stops another certificate on a paired name", () => {
    const r = checkPin({ host: `notes.${DOMAIN}`, servedSha256: OTHER, boxes, now: NOW });
    expect(r).toMatchObject({ verdict: "mismatch", serverDomain: DOMAIN, expected: CERT, served: OTHER });
    expect(finalAction(r.verdict)).toBe("block");
    expect(checkPin({ host: DOMAIN, servedSha256: null, boxes, now: NOW }).verdict).toBe("mismatch");
  });

  it("calls a week-old signature stale, and a box without one unchecked", () => {
    const old = { [DOMAIN]: box({ certSha256: CERT, issuedAt: NOW - 8 * DAY }) };
    expect(checkPin({ host: DOMAIN, servedSha256: CERT, boxes: old, now: NOW }).verdict).toBe("expired-evidence");
    const none = { [DOMAIN]: box(null) };
    expect(checkPin({ host: DOMAIN, servedSha256: CERT, boxes: none, now: NOW }).verdict).toBe("no-evidence");
    for (const v of ["expired-evidence", "no-evidence", "mismatch"]) expect(needsRefresh(v)).toBe(true);
    for (const v of ["expired-evidence", "no-evidence", "match", "unknown-name"]) expect(finalAction(v)).toBe("allow");
  });

  it("leaves names it doesn't know to Firefox", () => {
    expect(checkPin({ host: "home.bob.flagship.services", servedSha256: OTHER, boxes, now: NOW }).verdict).toBe("unknown-name");
    expect(checkPin({ host: "example.com", servedSha256: OTHER, boxes, now: NOW }).verdict).toBe("unknown-name");
  });

  it("vouches for a direct name only when it serves a paired box's signed leaf", () => {
    expect(checkPin({ host: "chess.fshp.app", servedSha256: CERT, boxes, now: NOW })).toMatchObject({ verdict: "match", serverDomain: DOMAIN });
    expect(checkPin({ host: "chess.fshp.app", servedSha256: OTHER, boxes, now: NOW }).verdict).toBe("unknown-name");
  });
});

describe("acceptEvidence", () => {
  it("takes a fresh report the box signed for the certificate this connection used", async () => {
    const v = await acceptEvidence({ box: box(null), body: signed(), servedSha256: CERT, now: NOW });
    expect(v).toEqual({ ok: true, evidence: { certSha256: CERT, certValidUntil: NOW + 60 * DAY, issuedAt: NOW } });
  });

  it("refuses a relayed report naming another certificate", async () => {
    const v = await acceptEvidence({ box: box(null), body: signed(), servedSha256: OTHER, now: NOW });
    expect(v).toMatchObject({ ok: false, reason: "served-other-certificate", expected: CERT, served: OTHER });
  });

  it("refuses a report signed by any key but the one the phone pinned", async () => {
    const v = await acceptEvidence({ box: box(null), body: signed({}, ed.utils.randomPrivateKey()), servedSha256: CERT, now: NOW });
    expect(v).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("refuses another server's report, an old one, a future one, and one older than the pin held", async () => {
    expect(await acceptEvidence({ box: box(null), body: signed({ serverDomain: "work.alice.flagship.services" }), servedSha256: CERT, now: NOW }))
      .toMatchObject({ reason: "other-server" });
    expect(await acceptEvidence({ box: box(null), body: signed({ issuedAt: NOW - 8 * DAY }), servedSha256: CERT, now: NOW }))
      .toMatchObject({ reason: "too-old" });
    expect(await acceptEvidence({ box: box(null), body: signed({ issuedAt: NOW + DAY }), servedSha256: CERT, now: NOW }))
      .toMatchObject({ reason: "from-the-future" });
    expect(await acceptEvidence({ box: box({ certSha256: CERT, issuedAt: NOW }), body: signed({ issuedAt: NOW - 1000 }), servedSha256: CERT, now: NOW }))
      .toMatchObject({ reason: "older-than-held" });
  });

  it("refuses a malformed body", async () => {
    expect(await acceptEvidence({ box: box(null), body: { report: { serverDomain: DOMAIN } }, servedSha256: CERT, now: NOW }))
      .toMatchObject({ reason: "malformed" });
    expect(await acceptEvidence({ box: box(null), body: signed({ certSha256: "AB".repeat(32) }), servedSha256: CERT, now: NOW }))
      .toMatchObject({ reason: "malformed" });
  });
});

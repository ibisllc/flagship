// The page's share card in the webapp (docs/voici-and-messages.md §2.10): the plan, when it is redrawn or carried,
// the drawing, the JPEG rules (1200 × 630, ≤ 256 KiB, no metadata) and the "share" piece a publish lists.
import { describe, expect, it } from "vitest";
import * as P from "../public/webapp/lib/voiciProtocol.js";
import {
  carriedShareCard,
  drawShareCard,
  fitText,
  renderShareCard,
  shareCardPlan,
  shareCardStale,
  VOICI_SHARE_COLORS,
} from "../public/webapp/lib/voiciShareCard.js";
import { buildVoiciIndex, defaultVoiciProfile } from "../public/webapp/lib/voiciOwner.js";

const U = "alice";
const UMK = new Uint8Array(32).fill(1);
const ADMIN_SEED = new Uint8Array(32).fill(3);
const signer = { kind: "admin-root", pub: P.hex(P.ed25519PublicKey(ADMIN_SEED)), sign: async (b: Uint8Array) => P.ed25519SignHex(b, ADMIN_SEED) };

/** A minimal JPEG: SOI, an APP0, an APP2 (as a browser's ICC profile), a frame header, the scan. */
function fakeJpeg(bodyLen: number) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app2 = [0xff, 0xe2, 0x00, 0x06, 1, 2, 3, 4];
  const sof = [0xff, 0xc0, 0x00, 0x0b, 8, 0x02, 0x76, 0x04, 0xb0, 1, 1, 0x11, 0];
  const scan = [0xff, 0xda, ...new Array(bodyLen).fill(7), 0xff, 0xd9];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app2, ...sof, ...scan]);
}

/** A 2D context that records its calls and measures 30 px per character. */
function recorder() {
  const calls: Array<[string, unknown[]]> = [];
  const g: Record<string, unknown> = { calls, font: "", fillStyle: "", textAlign: "", textBaseline: "" };
  for (const m of ["fillRect", "save", "restore", "beginPath", "arc", "closePath", "clip", "fill", "drawImage", "fillText"]) {
    g[m] = (...a: unknown[]) => calls.push([m, a]);
  }
  g.measureText = (t: string) => ({ width: [...t].length * 30 });
  return g as any;
}

describe("the share card plan", () => {
  it("takes the theme's colours, the name (or the username), the address and an initial", () => {
    const p = shareCardPlan({ ...defaultVoiciProfile(U), displayName: "élodie", theme: "ink" }, U);
    expect(p.colors).toEqual(VOICI_SHARE_COLORS.ink);
    expect([p.name, p.address, p.initial, p.hasPhoto]).toEqual(["élodie", "voi.ci/alice", "É", false]);
    expect(shareCardPlan({ displayName: " ", theme: "nope" }, U).name).toBe(U);
    expect(shareCardPlan({ displayName: "x", theme: "nope" }, U).colors).toEqual(VOICI_SHARE_COLORS.classic);
  });

  it("is redrawn when the page has none or the name, photo or theme changed; carried otherwise", () => {
    const profile = { ...defaultVoiciProfile(U), displayName: "Alice" };
    const ref = { role: "share", sha256: "ab".repeat(32), size: 1000 };
    const published = { profile, index: { pieces: [{ role: "profile", sha256: "cd".repeat(32), size: 9 }, ref] } };
    expect(shareCardStale(null, { profile })).toBe(true);
    expect(shareCardStale({ profile, index: { pieces: [] } }, { profile })).toBe(true);
    expect(shareCardStale(published, { profile })).toBe(false);
    expect(carriedShareCard(published, { profile })).toEqual({ sha256: ref.sha256, size: 1000, bytes: null });
    expect(shareCardStale(published, { profile: { ...profile, displayName: "Alicia" } })).toBe(true);
    expect(shareCardStale(published, { profile: { ...profile, theme: "sea" } })).toBe(true);
    expect(shareCardStale(published, { profile: { ...profile, avatar: "ef".repeat(32) } })).toBe(true);
    expect(shareCardStale(published, { profile: { ...profile, bio: "new bio" } })).toBe(false);
  });
});

describe("drawing the card", () => {
  it("fills the canvas, draws the initial disc without a photo, the name, the address and the wordmark", () => {
    const g = recorder();
    drawShareCard(g, shareCardPlan({ displayName: "Aya", theme: "classic" }, "aya"), null);
    const texts = g.calls.filter(([m]: [string]) => m === "fillText").map(([, a]: [string, unknown[]]) => a.slice(0, 3));
    expect(texts).toEqual([
      ["A", 220, 294],
      ["Aya", 400, 290],
      ["voi.ci/aya", 400, 360],
      ["voi.ci", 128, 582],
    ]);
    expect(g.calls[0]).toEqual(["fillRect", [0, 0, 1200, 630]]);
    expect(g.calls.some(([m]: [string]) => m === "drawImage")).toBe(false);
  });

  it("clips the photo into the circle when there is one", () => {
    const g = recorder();
    drawShareCard(g, shareCardPlan({ displayName: "Aya", avatar: "ab".repeat(32) }, "aya"), { width: 800, height: 600 });
    const draw = g.calls.find(([m]: [string]) => m === "drawImage");
    expect(draw[1].slice(1)).toEqual([100, 0, 600, 600, 100, 170, 240, 240]);
    expect(g.calls.some(([m]: [string]) => m === "clip")).toBe(true);
  });

  it("cuts a long name with an ellipsis to 700 px", () => {
    const g = recorder();
    expect(fitText(g, "a".repeat(30), 700)).toBe("a".repeat(22) + "…");
    expect(fitText(g, "short", 700)).toBe("short");
  });
});

describe("encoding the card", () => {
  const canvas = () => ({ getContext: () => recorder() });

  it("drops metadata and steps the quality down until it fits 256 KiB", async () => {
    const qualities: number[] = [];
    const bytes = await renderShareCard(
      { profile: { displayName: "Aya" }, username: "aya", avatar: null },
      { canvas, encode: async (_c: unknown, q: number) => (qualities.push(q), fakeJpeg(q > 0.6 ? 300 * 1024 : 50_000)) },
    );
    expect(qualities).toEqual([0.9, 0.8, 0.7, 0.6]);
    expect(P.isVoiciJpeg(bytes)).toBe(true);
    expect(P.voiciJpegHasMetadata(bytes)).toBe(false);
    expect(bytes.length).toBeLessThanOrEqual(P.VOICI_SHARE_IMAGE_MAX_BYTES);
  });

  it("refuses when even the lowest quality is too large", async () => {
    await expect(renderShareCard({ profile: { displayName: "Aya" }, username: "aya" }, { canvas, encode: async () => fakeJpeg(300 * 1024) })).rejects.toThrow("share-card-too-large");
  });
});

describe("the share piece in a publish", () => {
  const merged = { profile: { ...defaultVoiciProfile(U), displayName: "Alice" }, acceptsMessages: 1 as const, chunks: [] };

  it("lists a drawn card as the one 'share' piece and uploads it; a later index carries it without an upload", async () => {
    const bytes = fakeJpeg(1000).filter((_, i) => i < 20 || i >= 28); // without the APP2
    const share = { sha256: P.sha256Hex(bytes), size: bytes.length, bytes };
    const first = await buildVoiciIndex({ username: U, published: null, merged, images: new Map(), signer, umk: { seed: UMK }, now: 1_800_000_000_000, shareCard: share });
    expect(first.index.pieces.filter((p: { role: string }) => p.role === "share")).toEqual([{ role: "share", sha256: share.sha256, size: share.size }]);
    expect(first.uploads.map((u: { role: string }) => u.role)).toContain("share");
    expect(P.parseVoiciPageIndex(first.index)).not.toBeNull();
    const next = await buildVoiciIndex({
      username: U,
      published: { profile: merged.profile, index: first.index },
      merged,
      images: new Map(),
      signer,
      umk: { seed: UMK },
      now: 1_800_000_000_001,
    });
    expect(next.index.pieces.find((p: { role: string }) => p.role === "share").sha256).toBe(share.sha256);
    expect(next.uploads.map((u: { role: string }) => u.role)).not.toContain("share");
  });
});

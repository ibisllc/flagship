// The page's share card (docs/voici-and-messages.md §2.10, owner decision 2026-11-17): the 1200 × 630 picture link
// previews show for voi.ci/<username>. Drawn here, in the publishing app, and published as the signed "share" piece,
// so `.com` has no image pipeline. The same layout on iOS (VoiciShareCard.swift) and Android (VoiciShareCard.kt). It
// holds no words but the person's own name and address, so there is nothing to translate.

import { isVoiciJpeg, voiciJpegHasMetadata, VOICI_SHARE_IMAGE_HEIGHT, VOICI_SHARE_IMAGE_MAX_BYTES, VOICI_SHARE_IMAGE_WIDTH } from "./voiciProtocol.js";
import { squareCrop, stripJpegMetadata } from "./voiciImage.js";

export const VOICI_SHARE_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

/** Colours per theme: the page's light canvas, ink, muted ink, accent and hairline. */
export const VOICI_SHARE_COLORS = Object.freeze({
  classic: { canvas: "#f7f6f2", ink: "#14140f", muted: "#555149", accent: "#14b8a6", rule: "#e5e3dc" },
  sea: { canvas: "#f3f6f7", ink: "#0e1a1f", muted: "#4c5f67", accent: "#14b8a6", rule: "#e5e3dc" },
  ink: { canvas: "#0a0a09", ink: "#ece7d6", muted: "#a39d8f", accent: "#2dd4bf", rule: "#26241d" },
});

const SANS = "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"; // i18n: keep
const MONO = "'Geist Mono', ui-monospace, Menlo, Consolas, monospace"; // i18n: keep

/** What a card shows: the theme's colours, the name, the address and the letter used when there is no photo. */
export function shareCardPlan(profile, username) {
  const colors = VOICI_SHARE_COLORS[profile?.theme] ?? VOICI_SHARE_COLORS.classic;
  const name = String(profile?.displayName ?? "").trim() || username;
  const first = [...name][0] ?? "?";
  return { colors, name, address: `voi.ci/${username}`, initial: first.toUpperCase(), hasPhoto: Boolean(profile?.avatar) };
}

/** A new card is drawn when the page has none, or its name, photo or theme changed; otherwise the listed one is kept. */
export function shareCardStale(published, merged) {
  const ref = published?.index?.pieces?.find((p) => p.role === "share");
  if (!ref) return true;
  const a = published.profile ?? {};
  const b = merged.profile ?? {};
  return a.displayName !== b.displayName || (a.avatar ?? null) !== (b.avatar ?? null) || a.theme !== b.theme;
}

/** The listed card of the page a publish replaces, kept when nothing on it changed. */
export function carriedShareCard(published, merged) {
  if (shareCardStale(published, merged)) return null;
  const ref = published.index.pieces.find((p) => p.role === "share");
  return { sha256: ref.sha256, size: ref.size, bytes: null };
}

/** `text` cut with "…" until it is at most `max` wide under the context's current font. */
export function fitText(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const t = chars.join("").trimEnd() + "…";
    if (g.measureText(t).width <= max) return t;
  }
  return "…";
}

/** Draws the card on a 1200 × 630 2D context (a canvas, or a recording fake in tests). `photo`: a decoded image. */
export function drawShareCard(g, plan, photo) {
  const c = plan.colors;
  g.fillStyle = c.canvas;
  g.fillRect(0, 0, VOICI_SHARE_IMAGE_WIDTH, VOICI_SHARE_IMAGE_HEIGHT);
  g.save();
  g.beginPath();
  g.arc(220, 290, 120, 0, Math.PI * 2);
  g.closePath();
  if (photo) {
    g.clip();
    const crop = squareCrop(photo.width, photo.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(photo, crop.sx, crop.sy, crop.side, crop.side, 100, 170, 240, 240);
  } else {
    g.fillStyle = c.accent;
    g.fill();
    g.fillStyle = c.canvas;
    g.font = `bold 112px ${SANS}`; // i18n: keep
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(plan.initial, 220, 294);
  }
  g.restore();
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.fillStyle = c.ink;
  g.font = `bold 72px ${SANS}`; // i18n: keep
  g.fillText(fitText(g, plan.name, 700), 400, 290);
  g.fillStyle = c.muted;
  g.font = `40px ${MONO}`; // i18n: keep
  g.fillText(fitText(g, plan.address, 700), 400, 360);
  g.fillStyle = c.rule;
  g.fillRect(100, 519, 1000, 2);
  g.fillStyle = c.accent;
  g.beginPath();
  g.arc(110, 568, 9, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = c.ink;
  g.font = `bold 40px ${SANS}`; // i18n: keep
  g.fillText("voi.ci", 128, 582); // i18n: keep
}

/**
 * The card's JPEG bytes: drawn, encoded at falling quality until it fits 256 KiB, every metadata segment dropped and
 * checked. `deps.canvas(w, h)` / `deps.decode(bytes)` / `deps.encode(canvas, quality)` are seams for tests.
 */
export async function renderShareCard({ profile, username, avatar }, deps = {}) {
  const make = deps.canvas ?? newCanvas;
  const encode = deps.encode ?? encodeCanvas;
  const plan = shareCardPlan(profile, username);
  let photo = null;
  if (plan.hasPhoto && avatar) {
    try {
      photo = await (deps.decode ?? decodePhoto)(avatar);
    } catch {
      photo = null;
    }
  }
  if (typeof document !== "undefined" && document.fonts?.load) {
    await Promise.all([document.fonts.load(`bold 72px Geist`), document.fonts.load(`40px 'Geist Mono'`)]).catch(() => {}); // i18n: keep
  }
  const canvas = make(VOICI_SHARE_IMAGE_WIDTH, VOICI_SHARE_IMAGE_HEIGHT);
  drawShareCard(canvas.getContext("2d", { colorSpace: "srgb" }), plan, photo);
  for (const q of VOICI_SHARE_QUALITIES) {
    const bytes = stripJpegMetadata(await encode(canvas, q));
    if (!bytes || !isVoiciJpeg(bytes) || voiciJpegHasMetadata(bytes)) throw new Error("share-card");
    if (bytes.length <= VOICI_SHARE_IMAGE_MAX_BYTES) return bytes;
  }
  throw new Error("share-card-too-large");
}

function newCanvas(w, h) {
  return typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
}

async function encodeCanvas(canvas, quality) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/jpeg", quality })
    : await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return new Uint8Array(await blob.arrayBuffer());
}

async function decodePhoto(bytes) {
  return createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
}

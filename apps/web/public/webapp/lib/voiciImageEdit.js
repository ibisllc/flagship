// The photo editor's state for a voi.ci picture: quarter turns clockwise, a horizontal flip applied after the turns,
// and a square crop (zoom and centre) in the turned picture's pixels. iOS (VoiciImageEdit.swift) and Android
// (VoiciImageEdit.kt) run the same rules; packages/protocol/test-vectors/voici-image-edit pins them.
// Affine maps are [a, b, c, d, tx, ty]: (x, y) → (a·x + c·y + tx, b·x + d·y + ty), as canvas setTransform takes them.

export const VOICI_EDIT_MAX_ZOOM = 8;
export const VOICI_EDIT_MIN_CROP = 64;

export function maxZoom(dw, dh) {
  return Math.max(1, Math.min(VOICI_EDIT_MAX_ZOOM, Math.min(dw, dh) / VOICI_EDIT_MIN_CROP));
}

/** A fresh edit of a w × h picture: no turn, no flip, the largest centred square. */
export function newEdit(width, height) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return { width: w, height: h, turns: 0, flipped: false, zoom: 1, cx: w / 2, cy: h / 2 };
}

export function displaySize(e) {
  return e.turns % 2 === 0 ? [e.width, e.height] : [e.height, e.width];
}

/** The crop square in the turned picture. */
export function cropOf(e) {
  const [dw, dh] = displaySize(e);
  const side = Math.min(dw, dh) / e.zoom;
  return { x: e.cx - side / 2, y: e.cy - side / 2, side };
}

/** Source pixel → turned (and flipped) pixel. */
export function orientMatrix(e) {
  const { width: w, height: h } = e;
  let m;
  switch (e.turns) {
    case 1:
      m = [0, 1, -1, 0, h, 0];
      break;
    case 2:
      m = [-1, 0, 0, -1, w, h];
      break;
    case 3:
      m = [0, -1, 1, 0, 0, w];
      break;
    default:
      m = [1, 0, 0, 1, 0, 0];
  }
  if (e.flipped) {
    const [dw] = displaySize(e);
    m = [-m[0], m[1], -m[2], m[3], dw - m[4], m[5]];
  }
  return m.map((v) => v + 0);
}

/** Source pixel → output pixel for an output square `out` pixels wide. */
export function outputMatrix(e, out) {
  const o = orientMatrix(e);
  const c = cropOf(e);
  const s = out / c.side;
  return [s * o[0], s * o[1], s * o[2], s * o[3], s * (o[4] - c.x), s * (o[5] - c.y)].map((v) => v + 0);
}

function clamp(e) {
  const [dw, dh] = displaySize(e);
  const zoom = Math.min(Math.max(Number.isFinite(e.zoom) ? e.zoom : 1, 1), maxZoom(dw, dh));
  const half = Math.min(dw, dh) / zoom / 2;
  return { ...e, zoom, cx: Math.min(Math.max(e.cx, half), dw - half), cy: Math.min(Math.max(e.cy, half), dh - half) };
}

/** The picture as shown turned a quarter clockwise; the crop turns with it. */
export function rotate(e) {
  const [, dh] = displaySize(e);
  return clamp({ ...e, cx: dh - e.cy, cy: e.cx, turns: e.flipped ? (e.turns + 3) % 4 : (e.turns + 1) % 4 });
}

/** The picture as shown mirrored left to right; the crop mirrors with it. */
export function flip(e) {
  const next = { ...e, flipped: !e.flipped };
  const [dw] = displaySize(next);
  return clamp({ ...next, cx: dw - e.cx });
}

/** A drag of (dx, dy) on a crop frame `viewSide` wide moves the picture under the crop. */
export function pan(e, dx, dy, viewSide) {
  if (!(viewSide > 0)) return e;
  const k = cropOf(e).side / viewSide;
  return clamp({ ...e, cx: e.cx - dx * k, cy: e.cy - dy * k });
}

export function setZoom(e, zoom) {
  return clamp({ ...e, zoom });
}

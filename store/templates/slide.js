// Shared by every store template (store/templates/*.html). scripts/store-assets/render.mjs opens a template, calls
// window.renderSlide(spec), waits for the promise (fonts and the capture decoded, the caption fitted) and takes the
// screenshot at exactly spec.w x spec.h. Each template sets window.layout = (spec, kit) => void to draw its own body.
//
// spec: { w, h, lang, tone: "light"|"dark", eyebrow: { num, theme } | null, caption, foot: { left, standIn },
//         capture: { src, w, h, kind: "native"|"stand-in" } | null, missing: { path, state, screen } | null,
//         device: "iphone"|"ipad"|"android-phone"|"android-tablet"|"apple-watch"|"wear-os", watch: bool, first: bool }

const el = (tag, cls, parent, style) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) Object.assign(e.style, style);
  if (parent) parent.appendChild(e);
  return e;
};
const px = (n) => `${Math.round(n * 100) / 100}px`;

// Device outlines, all flat. ratio = bezel / device width; radius = corner / device width.
const DEVICES = {
  iphone: { bezel: 0.03, radius: 0.15, island: { w: 0.29, h: 0.085, top: 0.027 }, statusBar: 0.125, maxW: 0.86 },
  "android-phone": { bezel: 0.03, radius: 0.1, hole: { d: 0.034, top: 0.02 }, statusBar: 0.06, maxW: 0.86 },
  ipad: { bezel: 0.04, radius: 0.055, statusBar: 0.03, maxW: 0.9 },
  "android-tablet": { bezel: 0.045, radius: 0.05, statusBar: 0.03, maxW: 0.9 },
};

function head(spec, root) {
  const h = el("div", "head", root);
  if (spec.eyebrow) {
    const e = el("div", "eyebrow", h);
    el("span", "num", e).textContent = spec.eyebrow.num;
    el("span", "theme", e).textContent = spec.eyebrow.theme;
  }
  if (spec.caption != null) el("div", "caption", h).textContent = spec.caption;
  return h;
}

function shelf(spec, root) {
  el("div", "shelf", root);
  const f = el("div", "foot", root);
  el("span", "", f).textContent = spec.foot?.left ?? "";
  if (spec.foot?.standIn) el("span", "standin", f).textContent = "stand-in: webapp capture, not for upload";
}

function stage(root) {
  const s = el("div", "stage", root);
  const r = s.getBoundingClientRect();
  return { el: s, w: r.width, h: r.height, left: r.left, top: r.top };
}

/** The screen's content: the capture, or a placeholder that says which capture is missing. */
function screenContent(spec, screen, screenW, { round = false, statusBar = 0 } = {}) {
  if (spec.capture) {
    if (statusBar && spec.capture.kind === "stand-in") {
      // a webapp capture has no status bar: leave the room a phone's status bar takes, in the app's own canvas
      screen.style.background = spec.tone === "dark" ? "#0A0A09" : "#F7F6F2";
      const img = el("img", "", screen, { position: "absolute", left: 0, right: 0, bottom: 0, top: px(statusBar), height: `calc(100% - ${px(statusBar)})` });
      img.src = spec.capture.src;
      return img;
    }
    const img = el("img", "", screen);
    img.src = spec.capture.src;
    return img;
  }
  const m = el("div", "missing" + (round ? " round" : ""), screen, { "--ph-size": px(Math.max(11, screenW * 0.04)) });
  m.style.setProperty("--ph-size", px(Math.max(11, screenW * 0.04)));
  el("b", "", m).textContent = "CAPTURE MISSING";
  if (spec.missing) {
    el("span", "", m).textContent = spec.missing.path;
    if (spec.missing.state) el("span", "", m).textContent = `state: ${spec.missing.state}`;
    if (spec.missing.screen) el("span", "", m).textContent = spec.missing.screen;
  }
  return null;
}

/** A phone or tablet outline holding the capture, standing on the stage floor. Returns its box. */
function device(spec, st) {
  const d = DEVICES[spec.device];
  const aspect = spec.capture ? spec.capture.w / spec.capture.h : spec.captureAspect;
  const k = (1 - 2 * d.bezel) / aspect + 2 * d.bezel; // device height / device width
  const W = Math.min(st.w * d.maxW, st.h / k);
  const H = W * k;
  const box = el("div", "device", st.el, { width: px(W), height: px(H), borderRadius: px(W * d.radius) });
  const b = W * d.bezel;
  const screenW = W - 2 * b;
  const screen = el("div", "screen", box, { left: px(b), top: px(b), width: px(screenW), height: px(H - 2 * b), borderRadius: px(Math.max(0, W * d.radius - b)) });
  screenContent(spec, screen, screenW, { statusBar: d.statusBar * screenW });
  if (d.island) el("div", "island", box, { width: px(screenW * d.island.w), height: px(screenW * d.island.h), left: px(b + screenW * (1 - d.island.w) / 2), top: px(b + screenW * d.island.top) });
  if (d.hole) el("div", "island", box, { width: px(screenW * d.hole.d), height: px(screenW * d.hole.d), left: px(b + screenW * (1 - d.hole.d) / 2), top: px(b + screenW * d.hole.top) });
  // side buttons: a hint of hardware, no more
  if (spec.device === "iphone" || spec.device === "android-phone") {
    const bw = Math.max(2, W * 0.012);
    el("div", "button", box, { right: px(-bw), top: px(H * 0.22), width: px(bw), height: px(H * 0.1), borderRadius: px(bw) });
    if (spec.device === "iphone") el("div", "button", box, { left: px(-bw), top: px(H * 0.2), width: px(bw), height: px(H * 0.06), borderRadius: px(bw) });
  }
  const r = box.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** A watch: round for Wear OS, a rounded rectangle for Apple Watch; straps cut short so it stands on the floor. */
function watch(spec, st) {
  const round = spec.device === "wear-os";
  const screenAspect = round ? 1 : 422 / 514;
  const caseW = Math.min(st.w * 0.8, (st.h / 1.7) * (round ? 1 : 0.86));
  const inset = caseW * (round ? 0.075 : 0.07);
  const screenW = caseW - 2 * inset;
  const caseH = screenW / screenAspect + 2 * inset;
  const strapH = (st.h - caseH) / 2; // the straps run off the top of the stage and down to the floor
  const totalH = caseH + 2 * strapH;
  const w = el("div", "watch", st.el, { width: px(caseW), height: px(totalH) });
  const sr = round ? px(caseW * 0.08) : px(caseW * 0.05);
  el("div", "strap", w, { top: 0, height: px(strapH + caseH * 0.2), borderRadius: `${sr} ${sr} 0 0` });
  el("div", "strap", w, { bottom: 0, height: px(strapH + caseH * 0.2), borderRadius: `0 0 ${sr} ${sr}` });
  const c = el("div", "case", w, { left: 0, top: px(strapH), width: px(caseW), height: px(caseH), borderRadius: round ? "50%" : px(caseW * 0.27) });
  el("div", "crown", w, { left: px(caseW - caseW * 0.015), top: px(strapH + caseH * (round ? 0.42 : 0.3)), width: px(caseW * 0.06), height: px(caseH * 0.16) });
  const screen = el("div", "screen", c, { left: px(inset), top: px(inset), width: px(screenW), height: px(caseH - 2 * inset), borderRadius: round ? "50%" : px(caseW * 0.2) });
  screenContent(spec, screen, screenW, { round });
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Shrink the caption in 2 % steps until it fits in two lines, never below the thumbnail floor (brief §3). */
function fitCaption(spec) {
  const c = document.querySelector(".caption");
  if (!c) return { lines: 0, overflow: false };
  const base = spec.h * (spec.captionScale ?? 0.05);
  const floor = spec.h * (spec.captionFloor ?? 0.045);
  let size = base;
  let m;
  for (;;) {
    document.documentElement.style.setProperty("--caption-size", px(size));
    m = measure(c, spec.maxLines ?? 2);
    if (!m.overflow || size * 0.98 < floor) break;
    size *= 0.98;
  }
  return { ...m, sizePx: Math.round(size), scale: Math.round((size / base) * 1000) / 1000 };
}

function measure(c, maxLines) {
  const range = document.createRange();
  range.selectNodeContents(c);
  const tops = new Set();
  let right = 0;
  for (const r of range.getClientRects()) {
    if (r.width < 1) continue;
    tops.add(Math.round(r.top / 4));
    right = Math.max(right, r.right);
  }
  const box = c.getBoundingClientRect();
  const lines = tops.size;
  const overflowX = right > box.right + 1 || c.scrollWidth > c.clientWidth + 1;
  return { lines, overflowX, overflow: lines > maxLines || overflowX, text: c.textContent };
}

window.renderSlide = async (spec) => {
  const root = document.documentElement;
  root.lang = spec.lang;
  root.style.setProperty("--W", spec.w);
  root.style.setProperty("--H", spec.h);
  document.body.className = spec.tone;
  document.body.innerHTML = "";
  window.layout(spec, { el, px, head, shelf, stage, device, watch, screenContent });
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => (i.complete ? i.decode().catch(() => {}) : new Promise((ok) => { i.onload = i.onerror = ok; }))));
  const fit = fitCaption(spec);
  const broken = [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src);
  const fonts = [...document.fonts].filter((f) => f.status === "error").map((f) => f.family);
  return { fit, broken, fonts };
};

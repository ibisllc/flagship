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
  if (spec.caption != null) {
    const c = el("div", "caption", h);
    // a slide allowed a third line starts each sentence on its own line, so the lines break where the meaning does
    const parts = spec.splitSentences && !spec.caption.includes("\n") ? spec.caption.split(/(?<=[.。])\s+(?=\S)/) : [spec.caption];
    for (const p of parts) el("span", "", c, parts.length > 1 ? { display: "block" } : null).textContent = p;
  }
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

/** A phone or tablet outline holding the capture. Returns { box, W, H }; the caller places it. */
function deviceBox(spec, parent, W) {
  const d = DEVICES[spec.device];
  const aspect = spec.capture ? spec.capture.w / spec.capture.h : spec.captureAspect;
  const H = W * deviceK(spec);
  const box = el("div", "device", parent, { width: px(W), height: px(H), borderRadius: px(W * d.radius) });
  const b = W * d.bezel;
  const screenW = W - 2 * b;
  const screen = el("div", "screen", box, { left: px(b), top: px(b), width: px(screenW), height: px(H - 2 * b), borderRadius: px(Math.max(0, W * d.radius - b)) });
  screenContent(spec, screen, screenW, { statusBar: d.statusBar * screenW });
  if (d.island) el("div", "island", box, { width: px(screenW * d.island.w), height: px(screenW * d.island.h), left: px(b + screenW * (1 - d.island.w) / 2), top: px(b + screenW * d.island.top) });
  if (d.hole) el("div", "island", box, { width: px(screenW * d.hole.d), height: px(screenW * d.hole.d), left: px(b + screenW * (1 - d.hole.d) / 2), top: px(b + screenW * d.hole.top) });
  if (spec.device === "iphone" || spec.device === "android-phone") {
    const bw = Math.max(2, W * 0.012);
    el("div", "button", box, { right: px(-bw), top: px(H * 0.22), width: px(bw), height: px(H * 0.1), borderRadius: px(bw) });
    if (spec.device === "iphone") el("div", "button", box, { left: px(-bw), top: px(H * 0.2), width: px(bw), height: px(H * 0.06), borderRadius: px(bw) });
  }
  return { box, W, H };
}

/** device height / device width for this capture */
function deviceK(spec) {
  const d = DEVICES[spec.device];
  const aspect = spec.capture ? spec.capture.w / spec.capture.h : spec.captureAspect;
  return (1 - 2 * d.bezel) / aspect + 2 * d.bezel;
}

/** The legacy fitted device, standing on the stage floor (kept for templates that want the whole device). */
function device(spec, st) {
  const d = DEVICES[spec.device];
  const W = Math.min(st.w * d.maxW, st.h / deviceK(spec));
  const { box } = deviceBox(spec, st.el, W);
  const r = box.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The big device (store review: the app screen at least ~65 % of the image width, legible as a thumbnail): as wide
 *  as spec.deviceW of the canvas, under the caption, running off the bottom edge. spec.fit === "whole" keeps the whole
 *  device above the shelf instead (a slide whose point is at the bottom of the screen). Placed after the caption
 *  is fitted (window.place), so a one-line caption gives the device more room. */
function hero(spec, root) {
  const wide = spec.w > spec.h;
  // with a second frame (slide 01's caller in a browser) the device steps aside to make room for it
  const W = spec.w * (spec.deviceW ?? 0.84) * (spec.inset ? (wide ? 0.72 : 0.78) : 1);
  const dev = deviceBox(spec, root, W);
  dev.box.classList.add("hero");
  window.place = () => {
    const head = document.querySelector(".head").getBoundingClientRect();
    const top = head.bottom + spec.h * 0.028;
    let w = W;
    if (spec.fit === "whole") {
      const room = spec.h * 0.95 - top - spec.h * 0.012;
      w = Math.min(W, room / deviceK(spec));
    }
    const s = w / W;
    const pad = spec.w * 0.075;
    const left = !spec.inset ? (spec.w - W) / 2 : wide ? spec.w * 0.36 - W / 2 : spec.w - pad * 0.7 - W * (1 + s) / 2;
    Object.assign(dev.box.style, { left: px(left), top: px(top), transformOrigin: "top center", transform: s < 1 ? `scale(${s})` : "" });
    if (spec.first) {
      const d = spec.w > spec.h ? spec.h * 0.9 : spec.w * 1.16; // never behind the caption
      const cx = spec.inset ? left + W / 2 : spec.w / 2;
      const sun = el("div", "sun", root, { width: px(d), height: px(d), left: px(cx - d / 2), top: px(Math.max(top + Math.min(dev.H * s, spec.h - top) * 0.45, head.bottom + d / 2) - d / 2) });
    }
    if (spec.inset) browserFrame(spec, root, dev.box.getBoundingClientRect());
  };
  return dev;
}

/** Slide 01's second frame: the caller's browser on the owner's voi.ci page, Call pressed, over the lower half of
 *  the ringing phone (portrait: to its left; landscape: to its right). A plain window, no browser's own look: an
 *  address bar with the page's address, the page, and a soft touch mark on the button. */
function browserFrame(spec, root, d) {
  const wide = spec.w > spec.h;
  const ins = spec.inset;
  const IW = (wide ? spec.w * 0.3 : spec.w * 0.48) * (ins.scale ?? 1);
  const bar = IW * 0.12;
  const imgH = IW / (ins.aspect || 0.87);
  const H = bar + imgH;
  const floor = spec.h * 0.95 - spec.h * 0.02;
  const left = wide ? Math.min(d.right - IW * 0.3, spec.w - spec.w * 0.06 - IW) : spec.w * 0.04;
  // between the caller's name (top third of the ringing screen) and Decline / Answer (bottom sixth)
  const band = d.height * (wide ? 0.6 : 0.47);
  if (H > band) return browserFrame({ ...spec, inset: { ...ins, scale: (ins.scale ?? 1) * band / H } }, root, d);
  const top = Math.min(d.top + d.height * (wide ? 0.34 : 0.37), floor - H);
  const f = el("div", "browser", root, { left: px(left), top: px(top), width: px(IW), height: px(H), borderRadius: px(IW * 0.045), "--ring": px(Math.max(4, IW * 0.022)) });
  const b = el("div", "bar", f, { height: px(bar) });
  const addr = el("div", "addr", b, { height: px(bar * 0.6), fontSize: px(bar * 0.3), borderRadius: px(bar * 0.3) });
  addr.innerHTML = `<svg viewBox="0 0 16 16" width="${bar * 0.28}" height="${bar * 0.28}" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z"/></svg><span>voi.ci/river-otter</span>`;
  const page = el("div", "page", f, { top: px(bar), height: px(imgH) });
  if (ins.src) {
    el("img", "", page).src = ins.src;
    if (ins.tap) {
      const t = IW * 0.17;
      el("div", "tap", page, { width: px(t), height: px(t), left: px(ins.tap[0] * IW - t / 2), top: px(ins.tap[1] * imgH - t / 2) });
    }
  } else {
    const m = el("div", "missing", page, { "--ph-size": px(Math.max(11, IW * 0.035)) });
    el("b", "", m).textContent = "CAPTURE MISSING";
    el("span", "", m).textContent = ins.missing ?? "";
  }
}

/** A watch: round for Wear OS, a rounded rectangle for Apple Watch; straps cut short so it stands on the floor. */
function watch(spec, st) {
  const round = spec.device === "wear-os";
  const screenAspect = round ? 1 : 422 / 514;
  const caseW = Math.min(spec.w * 0.96, (st.h / 1.25) * (round ? 1 : 0.86));
  const inset = caseW * (round ? 0.075 : 0.07);
  const screenW = caseW - 2 * inset;
  const caseH = screenW / screenAspect + 2 * inset;
  const strapH = caseH * 0.07; // short band stubs in the case's colour: no grey slab behind the watch (store review)
  const totalH = caseH + 2 * strapH;
  const w = el("div", "watch", st.el, { width: px(caseW), height: px(totalH), alignSelf: "center" });
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
  // text nodes only: a block span's own box would count its line twice
  const tops = new Set();
  let right = 0;
  const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1) continue;
      tops.add(Math.round(r.top / 4));
      right = Math.max(right, r.right);
    }
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
  window.place = null;
  window.layout(spec, { el, px, head, shelf, stage, device, deviceBox, hero, watch, screenContent });
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => (i.complete ? i.decode().catch(() => {}) : new Promise((ok) => { i.onload = i.onerror = ok; }))));
  const fit = fitCaption(spec);
  if (window.place) window.place();
  // place() may add images of its own (slide 01's browser frame)
  await Promise.all([...document.images].map((i) => (i.complete ? i.decode().catch(() => {}) : new Promise((ok) => { i.onload = i.onerror = ok; }))));
  const broken = [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src);
  const fonts = [...document.fonts].filter((f) => f.status === "error").map((f) => f.family);
  return { fit, broken, fonts };
};

// The photo editor before a picture becomes the page photo (docs/social-tab.md), as on iOS and Android: the square
// the page will show, the picture moved under it by dragging (mouse, touch or arrow keys) and zoomed with a pinch, the
// wheel, the slider or +/-, Rotate (a quarter clockwise) and Flip (left to right), then Use or Cancel. The canvas is
// drawn through the same map the encoder applies (lib/voiciImageEdit.js outputMatrix), so preview and result match.

import { buildOverlay, ensureHost } from "../lib/modal.js";
import { escapeHtml } from "../lib/util.js";
import { tr } from "../lib/i18n.js";
import { flip, maxZoom, newEdit, outputMatrix, pan, rotate, setZoom, displaySize } from "../lib/voiciImageEdit.js";
import { drawEdited } from "../lib/voiciImage.js";
import { flipHorizontalIcon, rotateCwIcon } from "../lib/icons.js";

/** Opens the editor on a decoded picture ({width, height, source}). Resolves the edit on Use, null on Cancel. */
export function openPhotoEditor(img) {
  return new Promise((resolve) => {
    const host = ensureHost();
    const overlay = buildOverlay();
    overlay.innerHTML = `
      <div class="modal-card vp-sheet photo-editor" role="document" data-testid="photo-editor">
        <h3 class="modal-title">${escapeHtml(tr("Edit photo"))}</h3>
        <div class="photo-editor-frame">
          <canvas class="photo-editor-canvas" tabindex="0" role="img" data-testid="photo-edit-crop"
            aria-label="${escapeHtml(tr("Photo crop. Drag or use the arrow keys to move it, + and - to zoom."))}"></canvas>
        </div>
        <label class="photo-editor-zoom">
          <span>${escapeHtml(tr("Zoom"))}</span>
          <input type="range" min="1" step="0.01" value="1" id="photo-edit-zoom" />
        </label>
        <div class="photo-editor-tools">
          <button type="button" class="secondary" id="photo-edit-rotate"><span class="icon" aria-hidden="true">${rotateCwIcon}</span>${escapeHtml(tr("Rotate"))}</button>
          <button type="button" class="secondary" id="photo-edit-flip"><span class="icon" aria-hidden="true">${flipHorizontalIcon}</span>${escapeHtml(tr("Flip"))}</button>
        </div>
        <div class="row-2 mt-3">
          <button type="button" class="secondary" id="photo-edit-cancel">${escapeHtml(tr("Cancel"))}</button>
          <button type="button" id="photo-edit-use">${escapeHtml(tr("Use"))}</button>
        </div>
      </div>`;
    host.appendChild(overlay);
    document.body.classList.add("modal-open");

    const canvas = overlay.querySelector("canvas");
    const zoomInput = overlay.querySelector("#photo-edit-zoom");
    const g = canvas.getContext("2d");
    let edit = newEdit(img.width, img.height);
    let side = 0;

    const draw = () => {
      const css = Math.max(1, Math.round(canvas.getBoundingClientRect().width)) || 320;
      const px = Math.round(css * (window.devicePixelRatio || 1));
      if (canvas.width !== px) canvas.width = canvas.height = px;
      side = css;
      drawEdited(g, img.source, outputMatrix(edit, px), px);
      const [dw, dh] = displaySize(edit);
      zoomInput.max = String(maxZoom(dw, dh));
      zoomInput.value = String(edit.zoom);
    };
    const set = (next) => {
      edit = next;
      draw();
    };

    // Dragging with one pointer pans; two pointers pinch.
    const pointers = new Map();
    let pinch = null;
    canvas.addEventListener("pointerdown", (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: edit.zoom };
      }
    });
    canvas.addEventListener("pointermove", (ev) => {
      const prev = pointers.get(ev.pointerId);
      if (!prev) return;
      const now = { x: ev.clientX, y: ev.clientY };
      pointers.set(ev.pointerId, now);
      if (pointers.size === 1) set(pan(edit, now.x - prev.x, now.y - prev.y, side));
      else if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.dist > 0) set(setZoom(edit, pinch.zoom * (dist / pinch.dist)));
      }
    });
    const lift = (ev) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    canvas.addEventListener("pointerup", lift);
    canvas.addEventListener("pointercancel", lift);
    canvas.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        set(setZoom(edit, edit.zoom * Math.exp(-ev.deltaY / 400)));
      },
      { passive: false },
    );
    canvas.addEventListener("keydown", (ev) => {
      const step = ev.shiftKey ? 40 : 10;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[ev.key]) set(pan(edit, moves[ev.key][0], moves[ev.key][1], side));
      else if (ev.key === "+" || ev.key === "=") set(setZoom(edit, edit.zoom * 1.25));
      else if (ev.key === "-") set(setZoom(edit, edit.zoom / 1.25));
      else return;
      ev.preventDefault();
    });
    zoomInput.addEventListener("input", () => set(setZoom(edit, Number(zoomInput.value))));
    overlay.querySelector("#photo-edit-rotate").addEventListener("click", () => set(rotate(edit)));
    overlay.querySelector("#photo-edit-flip").addEventListener("click", () => set(flip(edit)));

    const onResize = () => draw();
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close(null);
      }
    };
    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      overlay.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      resolve(result);
    }
    overlay.querySelector("#photo-edit-cancel").addEventListener("click", () => close(null));
    overlay.querySelector("#photo-edit-use").addEventListener("click", () => close(edit));
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    draw();
    queueMicrotask(() => canvas.focus({ preventScroll: true }));
  });
}

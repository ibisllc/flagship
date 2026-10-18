// Nothing of a menu, dialog or sheet may survive the lock. The lock is a view
// swap, not an overlay, and a native <dialog> (showModal) lives in the browser's
// top layer, above every view, so without this sweep "Add/Restore server" or a
// backup passcode prompt would stay open and operable over the unlock screen.
//
// Called by the router whenever it shows a lock surface (unlock, PIN unlock,
// bootstrap), so every way of locking is covered: the Lock button, the PIN
// lock, a sign-out and a reload into the lock screen.

/** The views that are the lock surface. */
export const LOCK_VIEW_IDS = Object.freeze(["view-unlock", "view-pin-unlock", "view-bootstrap"]);

export function isLockView(id) {
  return LOCK_VIEW_IDS.includes(id);
}

/**
 * Close every open dialog, sheet and prompt. Promise-based prompts listen for
 * Escape on the document and settle as cancelled; native dialogs are closed
 * and removed; any overlay still standing afterwards is removed.
 */
export function dismissOverlays(doc = typeof document === "undefined" ? null : document) {
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  try {
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  } catch { /* a listener must never block locking */ }
  for (const dlg of doc.querySelectorAll("dialog")) {
    try {
      dlg.dispatchEvent(new Event("cancel", { cancelable: true }));
      if (dlg.open) dlg.close();
    } catch { /* already closed */ }
    dlg.remove();
  }
  for (const el of doc.querySelectorAll(".modal-overlay")) el.remove();
  for (const el of doc.querySelectorAll("[popover]")) {
    try { el.hidePopover?.(); } catch { /* not open */ }
  }
  doc.body?.classList.remove("modal-open");
  const active = doc.activeElement;
  if (active && active !== doc.body) {
    try { active.blur?.(); } catch { /* nothing focused */ }
  }
}

// A button that takes no tap for a moment after the layout above it changed.
//
// Home's "Add/Restore server" sits under banners that arrive after the page
// paints (account backup nudge, "sign in again", the paused-status line). A
// tap aimed at something that was there a moment ago would otherwise land on
// the button that moved under the finger.
//
// MIRRORS: Android Home (450 ms settle on Add/Restore server).

export const SETTLE_MS = 450;

/** @param {{ now?: () => number, ms?: number }} [deps] */
export function createSettleGuard(deps = {}) {
  const now = deps.now ?? (() => performance.now());
  const ms = deps.ms ?? SETTLE_MS;
  let changedAt = -Infinity;
  return {
    /** The layout above the button just changed. */
    note() {
      changedAt = now();
    },
    /** True when a tap may act now. */
    ready() {
      return now() - changedAt >= ms;
    },
  };
}

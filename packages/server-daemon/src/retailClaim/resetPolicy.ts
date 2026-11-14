// What a power cut during a reset does (docs/retail-box-setup.md §15, owner verbatim: "A server
// that powers off during resets should be bricked"). The ONE place that decides it, so the owner's
// final choice is a one-line change here.
//
// "wipe-start" (the doc's recommendation, assumed until the owner decides): the box writes an
// fsynced reset marker the moment the wipe starts, then crypto-erases the LUKS header, so the
// window is seconds. 5 presses and pulling the plug change nothing; a working server cannot be
// destroyed by anyone who merely reaches its button.
//
// "reset-gesture": the marker goes down at the 5 presses, and is removed when the reset window
// closes with no claim. A power cut anywhere in the 10-minute window then locks the box.

export type ResetLockPoint = "wipe-start" | "reset-gesture";

export const RESET_LOCK_POINT: ResetLockPoint = "wipe-start";

/** Whether the reset marker is written at this step of a reset. */
export function writesResetMarkerAt(step: ResetLockPoint, point: ResetLockPoint = RESET_LOCK_POINT): boolean {
  return step === point;
}

/** Whether a reset window that closed with no claim removes the marker (only when the gesture wrote it). */
export function clearsResetMarkerOnWindowEnd(point: ResetLockPoint = RESET_LOCK_POINT): boolean {
  return point === "reset-gesture";
}

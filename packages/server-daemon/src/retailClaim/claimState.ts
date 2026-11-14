// The claim lifecycle a retail box keeps on disk (docs/retail-box-setup.md §7.8, §15).
//
//   unclaimed  factory state: advertises for 10 minutes after power-on
//   claimed    a recipe was taken; no advert; 5 presses open the reset window
//   locked     a reset was cut short: serves nothing, takes only a fresh 5-press reset
//
// The reset window itself is never stored: a reboot during it closes it (back to claimed), unless
// the reset policy wrote the marker at the gesture.

import { readStateFile, removeDurable, writeFileDurable, keepCorruptAside } from "../durableFile.js";

export type ClaimLifecycle = "unclaimed" | "claimed" | "locked";

export interface StoredClaimState {
  v: 1;
  lifecycle: "unclaimed" | "claimed";
  claimedAt: number | null;
}

const isStored = (o: unknown): o is StoredClaimState => {
  if (typeof o !== "object" || o === null) return false;
  const s = o as Record<string, unknown>;
  return s.v === 1 && (s.lifecycle === "unclaimed" || s.lifecycle === "claimed") && (s.claimedAt === null || typeof s.claimedAt === "number");
};

export interface ResetMarker {
  v: 1;
  startedAt: number;
  step: "wipe-start" | "reset-gesture";
}

export class ClaimStateStore {
  constructor(
    private readonly statePath: string,
    private readonly markerPath: string,
  ) {}

  /** A damaged state file reads as claimed, the closed default: only a reset can claim the box again. */
  async load(): Promise<{ lifecycle: ClaimLifecycle; claimedAt: number | null }> {
    const marker = await readStateFile(this.markerPath);
    if (marker.kind !== "missing") return { lifecycle: "locked", claimedAt: null };
    const r = await readStateFile(this.statePath);
    if (r.kind === "missing") return { lifecycle: "unclaimed", claimedAt: null };
    if (r.kind === "ok") {
      try {
        const o = JSON.parse(r.text);
        if (isStored(o)) return { lifecycle: o.lifecycle, claimedAt: o.claimedAt };
      } catch {
        // falls through to the closed default
      }
    }
    await keepCorruptAside(this.statePath, r.kind === "unreadable" ? r.error : new Error("unparseable"), "the box takes a new owner only after a 5-press reset").catch(() => {});
    return { lifecycle: "claimed", claimedAt: null };
  }

  async markClaimed(at: number): Promise<void> {
    const s: StoredClaimState = { v: 1, lifecycle: "claimed", claimedAt: at };
    await writeFileDurable(this.statePath, JSON.stringify(s));
  }

  async markUnclaimed(): Promise<void> {
    const s: StoredClaimState = { v: 1, lifecycle: "unclaimed", claimedAt: null };
    await writeFileDurable(this.statePath, JSON.stringify(s));
  }

  /** Written (and fsynced) before the step it guards; see resetPolicy.ts. */
  async writeResetMarker(m: ResetMarker): Promise<void> {
    await writeFileDurable(this.markerPath, JSON.stringify(m));
  }

  async clearResetMarker(): Promise<void> {
    await removeDurable(this.markerPath);
  }
}

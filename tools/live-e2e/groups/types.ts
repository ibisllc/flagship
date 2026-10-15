import type { Account, Box } from "../lib/fleet.js";
import type { Recorder } from "../lib/harness.js";

/** A1/A2 = account A's `home`/`home2`; B1 = account B's `home`. */
export type Slot = "A1" | "A2" | "B1";

export interface GroupCtx {
  A: Account;
  B?: Account;
  rec: Recorder;
  dir: string;
  box(slot: Slot): Box;
}

export interface Group {
  name: string;
  title: string;
  needs: Slot[];
  /** Lower phases run first; groups in one phase run in parallel unless `parallel: false`. */
  phase: number;
  parallel?: boolean;
  run(ctx: GroupCtx): Promise<void>;
}

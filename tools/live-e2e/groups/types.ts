import type { Account, Box } from "../lib/fleet.js";
import type { Recorder } from "../lib/harness.js";

/** A1/A2/A3 = account A's `home`/`home2`/`home3`; B1/B2 = account B's `home`/`home2`; R1/R2 = the real account R's `home`/`home2`. */
export type Slot = "A1" | "A2" | "A3" | "B1" | "B2" | "R1" | "R2";

export interface GroupCtx {
  A: Account;
  B?: Account;
  /** The real (non-demo) account, when R1 is in the fleet. */
  R?: Account;
  rec: Recorder;
  dir: string;
  box(slot: Slot): Box;
  /** Whether an earlier group ran and passed every check (for checks that read what it left behind). */
  groupOk(name: string): boolean;
  /** Records a box a group provisioned itself, so teardown reaps it even if the group crashes. */
  adopt(acct: Account, box: Box): void;
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

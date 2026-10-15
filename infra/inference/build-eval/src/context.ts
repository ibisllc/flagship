/**
 * Which run, step and phase a model call belongs to. The box's code makes
 * its calls deep inside its own async chains; the runner sets this around
 * each step and the upstream (`shimHost.ts`) reads it to file each call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CallRecord, Phase } from "./accounting.js";
import type { MockHints } from "./scenarios.js";

export interface CallContext {
  runId: string;
  step: string;
  phase: Phase;
  /** Only the mock model reads these. */
  mock?: MockHints;
  record(c: CallRecord): void;
}

export const callContext = new AsyncLocalStorage<CallContext>();

/** Run `fn` with `patch` applied to the current context. */
export function withContext<T>(base: CallContext, patch: Partial<CallContext>, fn: () => Promise<T>): Promise<T> {
  return callContext.run({ ...base, ...patch }, fn);
}

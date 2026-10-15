import { accessLists } from "./accessLists.js";
import { appCopy } from "./appCopy.js";
import { core } from "./core.js";
import { enforcement } from "./enforcement.js";
import { gating } from "./gating.js";
import { lifecycle } from "./lifecycle.js";
import { runtimes } from "./runtimes.js";
import { serverOrder } from "./serverOrder.js";
import { share } from "./share.js";
import type { Group } from "./types.js";
import { update } from "./update.js";

export type { Group, GroupCtx, Slot } from "./types.js";

export const GROUPS: Group[] = [core, gating, enforcement, serverOrder, runtimes, accessLists, share, appCopy, update, lifecycle];

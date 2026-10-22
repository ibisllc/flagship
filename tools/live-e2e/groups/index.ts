import { accessLists } from "./accessLists.js";
import { activity } from "./activity.js";
import { aiChat } from "./aiChat.js";
import { aiStaging } from "./aiStaging.js";
import { apiKeys } from "./apiKeys.js";
import { appCopy } from "./appCopy.js";
import { archive } from "./archive.js";
import { backups } from "./backups.js";
import { core } from "./core.js";
import { enforcement } from "./enforcement.js";
import { freePlan } from "./freePlan.js";
import { gating } from "./gating.js";
import { invites } from "./invites.js";
import { lifecycle } from "./lifecycle.js";
import { mcpIde } from "./mcpIde.js";
import { migrate } from "./migrate.js";
import { namedLinks } from "./namedLinks.js";
import { oneList } from "./oneList.js";
import { quota } from "./quota.js";
import { realAccount } from "./realAccount.js";
import { remote } from "./remote.js";
import { runtimes } from "./runtimes.js";
import { serverOrder } from "./serverOrder.js";
import { share } from "./share.js";
import type { Group } from "./types.js";
import { update } from "./update.js";

export type { Group, GroupCtx, Slot } from "./types.js";

export const GROUPS: Group[] = [
  core,
  gating,
  invites,
  enforcement,
  serverOrder,
  runtimes,
  realAccount,
  freePlan,
  accessLists,
  aiStaging,
  share,
  apiKeys,
  remote,
  aiChat,
  migrate,
  appCopy,
  archive,
  mcpIde,
  activity,
  quota,
  backups,
  oneList,
  namedLinks,
  update,
  lifecycle,
];

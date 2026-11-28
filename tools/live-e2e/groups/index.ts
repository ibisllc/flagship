import { accessLists } from "./accessLists.js";
import { activity } from "./activity.js";
import { aiChat } from "./aiChat.js";
import { aiStaging } from "./aiStaging.js";
import { apiKeys } from "./apiKeys.js";
import { appCopy } from "./appCopy.js";
import { archive } from "./archive.js";
import { backups } from "./backups.js";
import { core } from "./core.js";
import { directAccess } from "./directAccess.js";
import { enforcement } from "./enforcement.js";
import { freePlan } from "./freePlan.js";
import { gating } from "./gating.js";
import { invites } from "./invites.js";
import { languages } from "./languages.js";
import { lifecycle } from "./lifecycle.js";
import { mcpIde } from "./mcpIde.js";
import { migrate } from "./migrate.js";
import { namedLinks } from "./namedLinks.js";
import { chooseName } from "./chooseName.js";
import { oneList } from "./oneList.js";
import { orgRead } from "./orgRead.js";
import { ohttpFailure } from "./ohttpFailure.js";
import { outboundProxy } from "./outboundProxy.js";
import { quota } from "./quota.js";
import { realAccount } from "./realAccount.js";
import { remote } from "./remote.js";
import { runtimes } from "./runtimes.js";
import { serverOrder } from "./serverOrder.js";
import { share } from "./share.js";
import type { Group } from "./types.js";
import { update } from "./update.js";
import { vouchers } from "./vouchers.js";
import { RELEASE_03_GROUPS } from "./release03/index.js";

export type { Group, GroupCtx, Slot } from "./types.js";

export const GROUPS: Group[] = [
  core,
  languages,
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
  chooseName,
  orgRead,
  directAccess,
  vouchers,
  outboundProxy,
  ohttpFailure,
  update,
  lifecycle,
  ...RELEASE_03_GROUPS,
];

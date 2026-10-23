// The live groups for what 0.3 added. Registered in groups/index.ts as `...RELEASE_03_GROUPS`.
import type { Group } from "../types.js";
import { aiConsent } from "./aiConsent.js";
import { appNames } from "./appNames.js";
import { chatCrossOwner } from "./chatCrossOwner.js";
import { firstContact } from "./firstContact.js";
import { originGeneration } from "./originGeneration.js";
import { passkeyRecovery } from "./passkeyRecovery.js";
import { releaseCatalog } from "./releaseCatalog.js";
import { serverSeen } from "./serverSeen.js";
import { upstreamSync } from "./upstreamSync.js";

export const RELEASE_03_GROUPS: Group[] = [
  firstContact,
  passkeyRecovery,
  serverSeen,
  releaseCatalog,
  originGeneration,
  aiConsent,
  upstreamSync,
  appNames,
  chatCrossOwner,
];

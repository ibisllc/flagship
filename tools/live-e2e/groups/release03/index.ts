// The live groups for what 0.3 added. Registered in groups/index.ts as `...RELEASE_03_GROUPS`.
import type { Group } from "../types.js";
import { adversarial } from "./adversarial.js";
import { aiConsent } from "./aiConsent.js";
import { browserGrants } from "./browserGrants.js";
import { appNames } from "./appNames.js";
import { canary } from "./canary.js";
import { chatCrossOwner } from "./chatCrossOwner.js";
import { firstContact } from "./firstContact.js";
import { originGeneration } from "./originGeneration.js";
import { passkeyRecovery } from "./passkeyRecovery.js";
import { releaseCatalog } from "./releaseCatalog.js";
import { serverSeen } from "./serverSeen.js";
import { upstreamSync } from "./upstreamSync.js";
import { wasiApps } from "./wasiApps.js";
import { appGroupsDb } from "./appGroupsDb.js";
import { gpuReal } from "./gpuReal.js";
import { gpuSim } from "./gpuSim.js";
import { localAi, localAiCpu } from "./localAi.js";
import { serving } from "./serving.js";
import { stackSwitch } from "./stackSwitch.js";

export const RELEASE_03_GROUPS: Group[] = [
  firstContact,
  passkeyRecovery,
  serverSeen,
  releaseCatalog,
  canary,
  originGeneration,
  aiConsent,
  upstreamSync,
  browserGrants,
  appNames,
  chatCrossOwner,
  adversarial,
  wasiApps,
  appGroupsDb,
  gpuSim,
  gpuReal,
  localAiCpu,
  localAi,
  stackSwitch,
  serving,
];

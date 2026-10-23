/**
 * Cross-owner chat, assembled (SECURITY-HARDENING-PLAN.md 16.6, 17.5-17.8, 18.7-18.8).
 *
 * Everything the harness needs to reach another owner's lead and to be reached: the signed carrier,
 * the public registry lookup, the exclusive lead term across the account's boxes, the two peer
 * routes (`/api/chat/wire`, `/api/chat/lease`) and the approval notifier. The runtime builds the
 * harness from {@link CrossOwnerChat.harnessOptions} and calls {@link CrossOwnerChat.attach}.
 */
import type { LeadAuthority } from "./admission.js";
import type { ApprovalRequest, ChatHarness, ChatNotifier, ChatTransport } from "./harness.js";
import { ChatLeadAuthority, buildLeaseVoterHandler } from "./leadAuthority.js";
import { comPeerDirectory, type ChatPeerDirectory } from "./peerDirectory.js";
import { buildWireReceiver, ChatWireTransport } from "./wire.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";

export interface CrossOwnerChatDeps {
  /** This server's FQDN. */
  self: string;
  /** Directory for the lease voter and the lead term. */
  dir: string;
  controlPlaneBaseUrl: string;
  /** Signs with the server identity key (the custodian). */
  sign: (msg: Uint8Array) => Uint8Array;
  /** Every server of the account, this one included. */
  members: () => string[];
  /** True while this box is the first live server in the owner's order. */
  shouldCampaign: () => boolean;
  /** Authenticated time (ms) or null while unsynced. */
  now: () => number | null;
  /** Wake the owner; the runtime binds the real one (screens event + content-free push) with `setNotifier`. */
  notify?: (r: ApprovalRequest) => void;
  fetchImpl?: typeof fetch;
  directory?: ChatPeerDirectory;
  baseUrl?: (serverDomain: string) => string;
  log?: (m: string) => void;
}

export interface CrossOwnerChat {
  transport: ChatTransport;
  lead: LeadAuthority;
  notifier: ChatNotifier;
  /** Peer routes to mount on the box's control surface. */
  handlers: Array<(req: HttpRequest) => Promise<HttpResponse | null>>;
  attach(harness: ChatHarness): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function buildCrossOwnerChat(d: CrossOwnerChatDeps): CrossOwnerChat {
  const directory = d.directory ?? comPeerDirectory({ controlPlaneBaseUrl: d.controlPlaneBaseUrl, ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}) });
  const transport = new ChatWireTransport({
    self: d.self.toLowerCase(),
    sign: d.sign,
    directory,
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
    ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
  });
  const lead = new ChatLeadAuthority({
    self: d.self.toLowerCase(),
    dir: d.dir,
    members: d.members,
    shouldCampaign: d.shouldCampaign,
    now: d.now,
    transport,
    ...(d.log ? { log: d.log } : {}),
  });
  let harness: ChatHarness | null = null;
  const wire = buildWireReceiver({
    self: d.self.toLowerCase(),
    directory,
    transport,
    deliver: async (frame, peerKey) => {
      await harness?.receive(frame, peerKey);
    },
  });
  const lease = buildLeaseVoterHandler({ self: d.self.toLowerCase(), directory, voter: lead.voter, members: d.members });
  return {
    transport,
    lead,
    notifier: { approval: (r) => d.notify?.(r) },
    handlers: [wire, lease],
    attach(h) {
      harness = h;
    },
    start: () => lead.start(),
    stop: () => lead.stop(),
  };
}

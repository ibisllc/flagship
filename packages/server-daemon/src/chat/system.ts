/**
 * Cross-owner chat, assembled (SECURITY-HARDENING-PLAN.md 16.6, 17.5-17.8, 18.8).
 *
 * Everything the harness needs to reach another owner's app and to be reached: the signed carrier
 * addressed to the app's canonical name, the public registry lookup that authenticates the sending
 * box, the app gate that receives frames on every app's own host, and the approval notifier.
 *
 * Who leads an app is the box the relay routes its canonical name to: only the box that holds the
 * name admits a cross-owner start or sends one for its own app, so an instance on another of the
 * owner's servers never starts a conversation whose replies would go elsewhere. The runtime builds
 * the harness from these parts and calls {@link CrossOwnerChat.attach}.
 */
import type { LeadAuthority } from "./admission.js";
import type { ApprovalRequest, ChatHarness, ChatNotifier, ChatTransport } from "./harness.js";
import { comPeerDirectory, type ChatPeerDirectory } from "./peerDirectory.js";
import { buildWireReceiver, ChatWireTransport } from "./wire.js";
import type { AppGate } from "../runtime.js";
import type { AppIdentity } from "./types.js";

export interface CrossOwnerChatDeps {
  /** This server's FQDN. */
  self: string;
  /** The account this server belongs to. */
  account: string;
  /** The services zone (`flagship.services`, or the gym's). */
  apex: string;
  controlPlaneBaseUrl: string;
  /** Signs with the server identity key (the custodian). */
  sign: (msg: Uint8Array) => Uint8Array;
  /** True while this box holds `app`'s canonical name at the relay. */
  holdsName: (app: AppIdentity) => boolean;
  /** The app an SNI-selected service id names; bound by the runtime once apps are loaded. */
  appOf?: (serviceRef: string) => AppIdentity | null;
  /** Wake the owner; the runtime binds the real one (screens event + content-free push) with `setNotifier`. */
  notify?: (r: ApprovalRequest) => void;
  fetchImpl?: typeof fetch;
  directory?: ChatPeerDirectory;
  baseUrl?: (host: string) => string;
}

export interface CrossOwnerChat {
  transport: ChatTransport;
  lead: LeadAuthority;
  notifier: ChatNotifier;
  /** Mounted ahead of every app: receives frames on the app's own host. */
  gate: AppGate;
  attach(harness: ChatHarness, appOf: (serviceRef: string) => AppIdentity | null): void;
}

/** Name-holding is the lead: there is no term to campaign for, so the generation never moves. */
export function nameHolderLead(holdsName: (app: AppIdentity) => boolean): LeadAuthority {
  return {
    generation: () => 1,
    mayAdmit: (appRef) => {
      if (!appRef) return false;
      const [author, slug] = appRef.split("--");
      return !!author && !!slug && holdsName({ author, slug });
    },
  };
}

export function buildCrossOwnerChat(d: CrossOwnerChatDeps): CrossOwnerChat {
  const directory = d.directory ?? comPeerDirectory({ controlPlaneBaseUrl: d.controlPlaneBaseUrl, ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}) });
  const transport = new ChatWireTransport({
    self: d.self.toLowerCase(),
    account: d.account,
    apex: d.apex,
    sign: d.sign,
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
    ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
  });
  let harness: ChatHarness | null = null;
  let appOf = d.appOf ?? (() => null);
  const gate = buildWireReceiver({
    account: d.account,
    directory,
    transport,
    appOf: (ref) => appOf(ref),
    deliver: async (frame, peerKey, via) => {
      await harness?.receive(frame, peerKey, via);
    },
  });
  return {
    transport,
    lead: nameHolderLead(d.holdsName),
    notifier: { approval: (r) => d.notify?.(r) },
    gate,
    attach(h, resolve) {
      harness = h;
      appOf = resolve;
    },
  };
}

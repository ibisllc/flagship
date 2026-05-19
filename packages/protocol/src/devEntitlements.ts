/**
 * Test helpers for minting RootEntitlement + ServiceEntitlement bundles.
 * Production daemons load these from the on-disk cache populated by
 * PhoneOrders; tests inject a freshly-minted bundle here.
 */

import {
  signServiceEntitlement,
  signRootEntitlement,
  type ServiceEntitlement,
  type RootEntitlement,
} from "./auth.js";
import type { Bytes, Keypair } from "./types.js";

export interface DevEntitlementBundle {
  rootEntitlement: RootEntitlement;
  rootEntitlementSig: Bytes;
  serviceEntitlement?: ServiceEntitlement;
  serviceEntitlementSig?: Bytes;
}

export function mintDevEntitlements(args: {
  irk: Keypair;
  podPubKey: Bytes;
  username: string;
  podCanonical: string;
  serviceCanonicals?: string[];
  /** Defaults to a 90-day service entitlement. */
  serviceExpiresInMs?: number;
  now?: () => number;
}): DevEntitlementBundle {
  const now = (args.now ?? (() => Date.now()))();
  const root: RootEntitlement = {
    username: args.username,
    podPubKey: args.podPubKey,
    podCanonical: args.podCanonical.toLowerCase(),
    issuedAt: now,
  };
  const rootSig = signRootEntitlement(root, args.irk);
  if (!args.serviceCanonicals || args.serviceCanonicals.length === 0) {
    return { rootEntitlement: root, rootEntitlementSig: rootSig };
  }
  const service: ServiceEntitlement = {
    username: args.username,
    podPubKey: args.podPubKey,
    canonicals: args.serviceCanonicals.map((s) => s.toLowerCase()),
    issuedAt: now,
    expiresAt: now + (args.serviceExpiresInMs ?? 90 * 24 * 60 * 60 * 1000),
  };
  const serviceSig = signServiceEntitlement(service, args.irk);
  return {
    rootEntitlement: root,
    rootEntitlementSig: rootSig,
    serviceEntitlement: service,
    serviceEntitlementSig: serviceSig,
  };
}

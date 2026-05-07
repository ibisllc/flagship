/**
 * Test helpers for minting RootEntitlement + AppEntitlement bundles.
 * Production daemons load these from the on-disk cache populated by
 * PhoneOrders; tests inject a freshly-minted bundle here.
 */

import {
  signAppEntitlement,
  signRootEntitlement,
  type AppEntitlement,
  type RootEntitlement,
} from "./auth.js";
import type { Bytes, Keypair } from "./types.js";

export interface DevEntitlementBundle {
  rootEntitlement: RootEntitlement;
  rootEntitlementSig: Bytes;
  appEntitlement?: AppEntitlement;
  appEntitlementSig?: Bytes;
}

export function mintDevEntitlements(args: {
  irk: Keypair;
  podPubKey: Bytes;
  username: string;
  podCanonical: string;
  appCanonicals?: string[];
  /** Defaults to a 90-day app entitlement. */
  appExpiresInMs?: number;
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
  if (!args.appCanonicals || args.appCanonicals.length === 0) {
    return { rootEntitlement: root, rootEntitlementSig: rootSig };
  }
  const app: AppEntitlement = {
    username: args.username,
    podPubKey: args.podPubKey,
    canonicals: args.appCanonicals.map((s) => s.toLowerCase()),
    issuedAt: now,
    expiresAt: now + (args.appExpiresInMs ?? 90 * 24 * 60 * 60 * 1000),
  };
  const appSig = signAppEntitlement(app, args.irk);
  return {
    rootEntitlement: root,
    rootEntitlementSig: rootSig,
    appEntitlement: app,
    appEntitlementSig: appSig,
  };
}

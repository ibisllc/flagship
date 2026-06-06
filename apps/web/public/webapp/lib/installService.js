// Install + uninstall helpers.
//
// The user's IRK lives in lib/state.js (loaded after unlock). To
// install a marketplace listing:
//   1. Pull the full listing (including the manifest JSON) from
//      .com via /api/marketplace/<creator>/<slug>.
//   2. Build an InstallServiceRequest, IRK-sign it.
//   3. POST to <pod>/api/services.
//
// The daemon verifies the signature against the host's IRK pubkey
// (== this user's IRK) and provisions data + container.

import { bytesToHex, signWithIrk } from "../keystore.js";
import { getPodBaseUrl } from "./api.js";
import { getSession } from "./state.js";

function canonicalInstallService({ serverId, creator, slug, manifestJson, addOwnerToMembership, issuedAt }) {
  return new TextEncoder().encode(
    [
      "flagship/install-service/v1",
      serverId,
      creator,
      slug,
      manifestJson,
      addOwnerToMembership ? "1" : "0",
      issuedAt,
    ].join("|"),
  );
}

function canonicalUninstallService({ serverId, creator, slug, issuedAt }) {
  return new TextEncoder().encode(
    [
      "flagship/uninstall-service/v1",
      serverId,
      creator,
      slug,
      issuedAt,
    ].join("|"),
  );
}

async function fetchListing(creator, slug) {
  // The webapp itself is hosted on flagshipserver.com so this is
  // same-origin; cookie-less; authenticated only by the listing being
  // public.
  const r = await fetch(
    `/api/marketplace/${encodeURIComponent(creator)}/${encodeURIComponent(slug)}`,
  );
  if (!r.ok) throw new Error(`marketplace listing fetch failed: ${r.status}`);
  return await r.json();
}

/**
 * Install a marketplace app onto the user's pod. Throws if the user
 * isn't paired, isn't unlocked, or the install endpoint rejects.
 */
export async function installFromMarketplace({ creator, slug }) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  const baseUrl = getPodBaseUrl();
  if (!baseUrl) throw new Error("not paired to a pod yet");

  const listing = await fetchListing(creator, slug);
  if (typeof listing.manifestJson !== "string") {
    throw new Error("marketplace listing missing manifestJson");
  }
  const serverId = new URL(baseUrl).host;
  const issuedAt = Date.now();
  const request = {
    serverId,
    creator,
    slug,
    manifestJson: listing.manifestJson,
    addOwnerToMembership: true,
    issuedAt,
  };
  const sig = await signWithIrk(session.umk, canonicalInstallService(request));
  const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/services`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request, signature: bytesToHex(sig) }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`install rejected: ${r.status} ${text}`.trim());
  }
  return await r.json();
}

/**
 * Uninstall an app from the user's pod. Idempotent on the daemon side.
 */
export async function uninstallService({ creator, slug }) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  const baseUrl = getPodBaseUrl();
  if (!baseUrl) throw new Error("not paired to a pod yet");

  const serverId = new URL(baseUrl).host;
  const issuedAt = Date.now();
  const request = { serverId, creator, slug, issuedAt };
  const sig = await signWithIrk(session.umk, canonicalUninstallService(request));
  const serviceId = `${creator}--${slug}`;
  const r = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/api/services/${encodeURIComponent(serviceId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, signature: bytesToHex(sig) }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`uninstall rejected: ${r.status} ${text}`.trim());
  }
}

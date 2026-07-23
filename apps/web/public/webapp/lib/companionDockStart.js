import { controlApex } from "./apex.js";
import { persistCompanionSession } from "./companionReceiver.js";

export const DOCK_POLL_INTERVAL_MS = 1500;

export async function resolveDockServers(username, deps = {}) {
  const clean = String(username ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clean)) throw new Error("Enter a valid username");
  const f = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!f) throw new Error("Browser networking is unavailable");
  const apex = deps.controlApex ?? controlApex();
  const response = await f(`${apex}/api/users/${encodeURIComponent(clean)}/pods`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Couldn't find that cloud");
  const body = await response.json();
  const seen = new Set();
  const servers = [];
  for (const pod of body?.pods ?? []) {
    const fqdn = String(pod?.serverDomain ?? pod?.fqdn ?? "").trim().toLowerCase();
    if (!fqdn || seen.has(fqdn)) continue;
    seen.add(fqdn);
    servers.push({
      fqdn,
      name: String(pod?.name ?? fqdn.split(".")[0] ?? fqdn),
      online: pod?.liveness === "live" || pod?.state === "online",
    });
  }
  return { username: clean, servers };
}

/** Build the deep link the phone scans to approve this browser.
 *
 *  The host label is `remote` as of 2026-07-23 (the feature's name). Both
 *  phone clients still parse `flagship://dock` too, so an app built before
 *  the rename keeps working against a browser built after it. Nothing but
 *  the label changed — the three query params are byte-identical. */
export function buildDockApprovalUrl({ requestId, approvalSecret, podBaseUrl }) {
  if (!/^[0-9a-f]{32}$/.test(requestId ?? "")) throw new Error("Invalid remote request id");
  if (!/^[0-9a-f]{64}$/.test(approvalSecret ?? "")) throw new Error("Invalid remote approval secret");
  const pod = new URL(podBaseUrl);
  const params = new URLSearchParams({
    server: pod.host,
    request: requestId,
    code: approvalSecret,
  });
  return `flagship://remote?${params.toString()}`;
}

export async function beginDockRequest(podBaseUrl, deps = {}) {
  const f = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!f) throw new Error("Browser networking is unavailable");
  const pollSecret = deps.pollSecret ?? randomHex(32, deps.cryptoImpl ?? globalThis.crypto);
  const base = String(podBaseUrl ?? "").replace(/\/+$/, "");
  const response = await f(`${base}/api/companion/dock/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pollSecret,
      userAgent: deps.userAgent ?? globalThis.navigator?.userAgent ?? "",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? "Couldn't start the remote session");
  return {
    ...body,
    pollSecret,
    approvalUrl: buildDockApprovalUrl({
      requestId: body.requestId,
      approvalSecret: body.approvalSecret,
      podBaseUrl: body.podBaseUrl ?? base,
    }),
  };
}

export async function pollDockRequest(request, deps = {}) {
  const f = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!f) throw new Error("Browser networking is unavailable");
  const response = await f(`${request.podBaseUrl.replace(/\/+$/, "")}/api/companion/dock/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: request.requestId,
      pollSecret: request.pollSecret,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 202) return { status: "pending", ...body };
  if (!response.ok) throw new Error(body?.error ?? "The remote session failed");
  return body;
}

export async function waitForDockApproval(request, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = deps.intervalMs ?? DOCK_POLL_INTERVAL_MS;
  while (now() < request.expiresAt) {
    const result = await pollDockRequest(request, deps);
    deps.onPoll?.(result);
    if (result.status === "approved") return result;
    await delay(intervalMs);
  }
  throw new Error("This remote code expired. Start again.");
}

export function activateDockedBrowser(result) {
  return persistCompanionSession(result);
}

function randomHex(byteCount, cryptoImpl) {
  if (!cryptoImpl?.getRandomValues) throw new Error("Secure randomness is unavailable");
  const bytes = new Uint8Array(byteCount);
  cryptoImpl.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

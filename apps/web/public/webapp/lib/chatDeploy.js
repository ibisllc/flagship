// The chat ("vibe") build's Deploy. The box stages the app as a private test
// copy (the session's AI may fix a copy that won't start), seals the session,
// then installs the tested image. A box with staging answers the
// `{background:true}` request at once (202 `{ok, started}`) and the session
// says where it is; an older box ignores `background` and answers with the
// finished result, which is handled the same way.
// docs/ai-privacy-and-staging.md §2.

import { ScreensError } from "./api.js";

export const DEPLOY_STAGING = "Testing the app on a private copy…";
export const DEPLOY_FIXING = "The AI is fixing a problem it found…";
export const DEPLOY_GOING_LIVE = "Installing…";
export const DEPLOYING = "Deploying…";
export const DEPLOY_FAILED = "The app couldn't be deployed.";
export const DEPLOY_TOO_LONG = "Deploying is taking unusually long. Check Build sessions later to see how it went.";

const POLL_INTERVAL_MS = 1500;
const POLL_LIMIT_MS = 30 * 60 * 1000;
const MAX_MISSES = 5;

/** The status line while a deploy runs, from the session's `deployPhase`. */
export function deployPhaseText(phase) {
  switch (phase) {
    case "staging": return DEPLOY_STAGING;
    case "fixing": return DEPLOY_FIXING;
    case "going-live": return DEPLOY_GOING_LIVE;
    default: return DEPLOYING;
  }
}

/** The request body: ask for the background deploy. */
export function deployRequestBody() {
  return { background: true };
}

/** A session snapshot's status + phase (top level, or under `meta`). */
export function snapshotStatus(snap) {
  const meta = snap && typeof snap.meta === "object" && snap.meta !== null ? snap.meta : {};
  return {
    status: snap?.status ?? meta.status ?? null,
    deployPhase: snap?.deployPhase ?? meta.deployPhase ?? null,
    url: snap?.deployedUrl ?? snap?.url ?? meta.url ?? null,
    reason: snap?.errorReason ?? snap?.failureReason ?? meta.failureReason ?? null,
  };
}

/** A second Deploy while one runs: the box says "already deploying" (409). */
export function alreadyDeploying(e) {
  return e instanceof ScreensError && e.status === 409 && /already deploying/i.test(e.message ?? "");
}

/**
 * Deploy and follow it to its end. `start()` posts the deploy and resolves to
 * its JSON body (throws a ScreensError on a non-2xx); `fetchSnapshot()` reads
 * the session (`GET /api/screens/vibe-code/:id`). Resolves to
 * `{ok:true, url, serviceId?, inviteOnly?}` or `{ok:false, reason}`; throws
 * once polls fail `MAX_MISSES` times in a row.
 */
export async function startAndFollowChatDeploy({
  start,
  fetchSnapshot,
  onPhase = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  intervalMs = POLL_INTERVAL_MS,
  limitMs = POLL_LIMIT_MS,
}) {
  let r;
  try {
    r = await start();
  } catch (e) {
    if (!alreadyDeploying(e)) throw e;
    r = { started: true };
  }
  if (r?.started !== true) {
    // An older box: the finished result.
    return { ok: true, url: r?.url ?? null, ...(r?.serviceId ? { serviceId: r.serviceId } : {}), ...(typeof r?.inviteOnly === "boolean" ? { inviteOnly: r.inviteOnly } : {}) };
  }
  onPhase("staging");
  const deadline = now() + limitMs;
  let misses = 0;
  while (now() < deadline) {
    await sleep(intervalMs);
    let s;
    try {
      s = snapshotStatus(await fetchSnapshot());
      misses = 0;
    } catch (e) {
      misses += 1;
      if (misses >= MAX_MISSES) throw e;
      continue;
    }
    if (s.status === "deployed") return { ok: true, url: s.url };
    if (s.status === "failed" || s.status === "cancelled") return { ok: false, reason: s.reason || DEPLOY_FAILED };
    if (s.status === "deploying") onPhase(s.deployPhase);
  }
  return { ok: false, reason: DEPLOY_TOO_LONG };
}

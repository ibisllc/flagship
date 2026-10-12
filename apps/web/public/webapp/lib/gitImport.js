// Git import: the name field, the box's refusals, and following an AI adapt
// that runs in the background on the box.
//
// MIRRORS: iOS BuildGitViewModel + BuildGitScreen, Android BuildGit.

import { slugify, conflictFromError } from "./vibeNames.js";
import { ScreensError, boxReason, buildEntryError } from "./api.js";

export const NOT_READY_MISSING = "This repo is not yet adapted for Flagship.";
export const ADAPT_BUTTON = "Use AI to adapt and deploy";
export const ADAPTING = "The AI is adapting the repo…";
export const ADAPTING_STAGING = "The AI is adapting and testing the app on a private copy with sample data…";
export const ADAPTING_GOING_LIVE = "Installing the tested app…";
export const NOT_LIVE = "The app didn't go live.";
export const NOT_LIVE_FALLBACK = "The tested app couldn't be installed.";
export const RETRY_ADAPT = "Try again";
export const CLOSED_NOTE = "The AI's work on this build is done. Check the repo again to start a new build.";
export const ADAPTING_NOTE = "This can take several minutes. You can leave this screen; Build sessions shows how it went.";
export const ADAPT_TOO_LONG = "The AI is taking unusually long. Check Build sessions later to see how it went.";
export const ADAPT_FAILED = "The AI couldn't adapt this repo.";
export const ADAPTER_FILE_NAME = "flagship.app.json";
export const EXPORT_BUTTON = "Get flagship.app.json";
export const EXPORT_PREPARING = "Preparing…";
export const EXPORT_NOTE = "Is this your repo? Commit this file at its root and every Flagship server will run it this way.";
export const SHARE_LABEL = "Anonymously share your adaptation";
export const SHARE_NOTE = "Others can then install this repo without AI. Nothing about you or your server is included.";
export const CHECK_AGAIN = "Check again";

const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT_MS = 45 * 60 * 1000;
const MAX_MISSES = 5;

/** A repo without a manifest gets the plain sentence; a broken manifest
 *  keeps the box's reason, which says what is wrong with it. */
export function notReadyText(reason) {
  const r = String(reason ?? "");
  return r.startsWith("no flagship.app.json") ? NOT_READY_MISSING : r;
}

/** The label the address will have: the typed name, the one the box chose,
 *  or a stand-in until the repo is checked. */
export function addressLabel(slug, assignedName) {
  return slug || assignedName || "<repo name>";
}

export function blankNameHint(ref) {
  return `Leave it blank to name it after the repo${String(ref ?? "").trim() ? " and branch" : ""}.`;
}

export function gitRequestBody({ gitUrl, ref, name }) {
  const body = { gitUrl: String(gitUrl ?? "").trim() };
  const r = String(ref ?? "").trim();
  if (r) body.ref = r;
  const slug = slugify(name);
  if (slug) body.name = slug;
  return body;
}

/** The background adapt. `share` is the not-ready card's switch: whether the
 *  box publishes the adaptation to the public store once it deploys. */
export function adaptRequestBody({ credential, share = true }) {
  return { ...(credential ? { credential } : {}), background: true, share: share !== false };
}

/** What the box is doing while an adapt runs: the AI testing on its private
 *  copy ("staging"), or the box installing what it tested ("going-live").
 *  An older box sends no phase. */
export function adaptingText(phase) {
  if (phase === "staging") return ADAPTING_STAGING;
  if (phase === "going-live") return ADAPTING_GOING_LIVE;
  return ADAPTING;
}

/** A build the box has handed over to go live never takes an AI again: its
 *  `state.sealed`, or the 409 "This build is closed to the AI…". */
export function closedToAi(e) {
  return e instanceof ScreensError && e.status === 409 && /closed to the AI/i.test(boxReason(e) ?? e.message ?? "");
}

/** A failed Install: a shared adaptation that crashed here hands the repo to
 *  the owner's AI (`{needsAdapt, reason}`); anything else is an error. */
export function deployFailure(e) {
  const reason = boxReason(e) ?? (e instanceof ScreensError ? e.message : String(e));
  return e?.body && typeof e.body === "object" && e.body.needsAdapt === true
    ? { needsAdapt: true, reason }
    : { message: reason };
}

/** An adapt the box already started itself (409): follow it instead. */
export function adaptAlreadyRunning(e) {
  return e instanceof ScreensError && e.status === 409 && !closedToAi(e);
}

/**
 * Start the AI adapt and follow it to its end. `start()` posts the adapt;
 * `follow()` polls a background run (see `followAdapt`). An older box answers
 * with the finished result; a 409 means the box already started the AI
 * itself (a shared adaptation crashed and it had a key), so follow that run.
 * Other failures (a 503 included) are thrown for the caller.
 */
export async function startAndFollowAdapt({ start, follow }) {
  let r;
  try {
    r = await start();
  } catch (e) {
    if (closedToAi(e)) return { phase: "failed", reason: boxReason(e) ?? e.message, sealed: true };
    if (adaptAlreadyRunning(e)) return follow();
    throw e;
  }
  return r?.started === true ? follow() : adaptFinished(r || {});
}

/** Why "Check repo" was refused: a taken name, the box's own reason, or the
 *  usual message. */
export function checkRepoFailure(e) {
  const conflict = conflictFromError(e);
  if (conflict) return { conflict };
  if (e?.status === 400 || e?.status === 422) {
    const reason = boxReason(e);
    if (reason) return { message: reason };
  }
  return { message: buildEntryError(e) };
}

/** What a finished adapt leaves: installed when the box put the tested app
 *  live; not live (with the box's reason) when that failed; otherwise adapted
 *  files to install (an older box, or no tested copy). */
export function adaptFinished({ fileCount, deployed, deployedUrl, reason }) {
  if (deployed === true && deployedUrl) return { phase: "installed", url: deployedUrl };
  if (deployed === false && typeof reason === "string" && reason) return { phase: "not-live", reason };
  return { phase: "adapted", fileCount: fileCount ?? 0 };
}

/**
 * Poll a background adapt until it finishes. Resolves to
 * `{phase:"installed"|"adapted"|"not-live"|"failed", …}` (a failed one
 * carries `sealed` when the build is closed to the AI); throws once polls
 * fail `MAX_MISSES` times in a row. `onPhase` gets the box's running phase.
 */
export async function followAdapt({
  fetchState,
  fetchJournal,
  onProgress = () => {},
  onPhase = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  intervalMs = POLL_INTERVAL_MS,
  limitMs = POLL_LIMIT_MS,
}) {
  const deadline = now() + limitMs;
  let misses = 0;
  while (now() < deadline) {
    await sleep(intervalMs);
    let adapt;
    let sealed = false;
    try {
      const state = (await fetchState())?.state;
      adapt = state?.adapt;
      sealed = state?.sealed === true;
      misses = 0;
    } catch (e) {
      // A dropped poll (Wi-Fi blip, box restarting) isn't the end.
      misses += 1;
      if (misses >= MAX_MISSES) throw e;
      continue;
    }
    if (adapt?.status === "done") return adaptFinished(adapt);
    if (adapt?.status === "failed") {
      return { phase: "failed", reason: adapt.reason || ADAPT_FAILED, ...(sealed ? { sealed: true } : {}) };
    }
    if (adapt?.status === "running") onPhase(adapt.phase ?? null);
    try {
      const entries = (await fetchJournal())?.entries || [];
      const last = entries[entries.length - 1];
      if (last?.summary) onProgress(last.summary);
    } catch {
      // progress is a nicety
    }
  }
  return { phase: "failed", reason: ADAPT_TOO_LONG };
}

/** Save `text` as flagship.app.json through a temporary <a download>. */
export function downloadAdapterFile(text, { doc = globalThis.document, urls = globalThis.URL, later = setTimeout } = {}) {
  const blob = new Blob([text], { type: "application/json" });
  const href = urls.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = href;
  a.download = ADAPTER_FILE_NAME;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  later(() => urls.revokeObjectURL(href), 4000);
  return blob;
}

/**
 * Fetch the flagship.app.json that makes this repo run the way this build
 * does, for the repo's author to commit, and hand it to `save`. Resolves to
 * `{ok:true}` or `{ok:false, message}` with the box's reason when it gave one.
 */
export async function exportAdapter({ buildId, fetchJson, save = downloadAdapterFile }) {
  try {
    const r = await fetchJson(`/api/build/sessions/${encodeURIComponent(buildId)}/adapter`);
    if (typeof r?.file !== "string") throw new ScreensError("The box sent no flagship.app.json.", 0);
    save(r.file);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: boxReason(e) ?? (e instanceof ScreensError ? e.message : String(e)) };
  }
}

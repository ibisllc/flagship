// Git import: the name field, the box's refusals, and following an AI adapt
// that runs in the background on the box.
//
// MIRRORS: iOS BuildGitViewModel + BuildGitScreen, Android BuildGit.

import { slugify, conflictFromError } from "./vibeNames.js";
import { boxReason, buildEntryError } from "./api.js";

export const NOT_READY_MISSING = "This repo has no flagship.app.json and is not yet adapted to run on Flagship.";
export const ADAPT_BUTTON = "Use AI to prepare repo for Flagship";
export const ADAPTING = "The AI is adapting the repo…";
export const ADAPTING_NOTE = "This can take several minutes. You can leave this screen; Build sessions shows how it went.";
export const ADAPT_TOO_LONG = "The AI is taking unusually long. Check Build sessions later to see how it went.";
export const ADAPT_FAILED = "The AI couldn't adapt this repo.";

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

/** What a finished adapt leaves: installed when the AI deployed it itself. */
export function adaptFinished({ fileCount, deployed, deployedUrl }) {
  return deployed === true && deployedUrl
    ? { phase: "installed", url: deployedUrl }
    : { phase: "adapted", fileCount: fileCount ?? 0 };
}

/**
 * Poll a background adapt until it finishes. Resolves to
 * `{phase:"installed"|"adapted"|"failed", …}`; throws once polls fail
 * `MAX_MISSES` times in a row.
 */
export async function followAdapt({
  fetchState,
  fetchJournal,
  onProgress = () => {},
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
    try {
      adapt = (await fetchState())?.state?.adapt;
      misses = 0;
    } catch (e) {
      // A dropped poll (Wi-Fi blip, box restarting) isn't the end.
      misses += 1;
      if (misses >= MAX_MISSES) throw e;
      continue;
    }
    if (adapt?.status === "done") return adaptFinished(adapt);
    if (adapt?.status === "failed") return { phase: "failed", reason: adapt.reason || ADAPT_FAILED };
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

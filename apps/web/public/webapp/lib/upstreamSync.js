// "Check for updates from <repo>" for an app imported from a repo (N12, SECURITY-HARDENING-PLAN.md
// 18.12; packages/server-daemon/src/buildmodes/syncProposal.ts). The box clones ONE upstream version,
// compares it with the tree the app was imported at and what runs now, and opens a build holding the
// merge: upstream-only changes taken, the owner's own kept, conflicts keeping the owner's version.
// The webapp shows that proposal (capability changes on their own, before the code) and then the
// usual git build screen; nothing goes live until the owner deploys there.

import { boxClient } from "./api.js";
import { humanError } from "./humanError.js";
import { escapeHtml } from "./util.js";
import { refreshIcon } from "./icons.js";
import { toast } from "./toast.js";
import { tr, trn } from "./i18n.js";

export const SYNC_REF_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

export const SYNC_COPY = Object.freeze({
  refLabel: tr("Branch, tag or commit (optional)"),
  check: tr("Check for updates"),
  cancel: tr("Cancel"),
  close: tr("Close"),
  review: tr("Review and deploy"),
  discard: tr("Discard"),
  footer: tr("Nothing goes live until you deploy."),
  permsTitle: tr("New permissions"),
  permsBody: tr("This update changes what the app is allowed to do. Review before you deploy."),
  conflictsNote: tr("Resolve them in the build before you deploy, or deploy with your version."),
  notImported: tr("This app wasn't imported from a repo on this server, so it can't check for updates."),
  badRef: tr("Enter a branch, tag or commit name, or leave it empty."),
});

const SECTION_LABEL = Object.freeze({
  "network.egress": tr("Internet access"),
  "network.subdomain": tr("Web addresses"),
  "data.stores": tr("Data stores"),
  "browser.domains": tr("Browser sites"),
  access: tr("Public pages"),
  runtime: tr("Runtime"),
  distribution: tr("Distribution"),
});

export const sectionLabel = (s) => SECTION_LABEL[s] ?? s;

/** The repo an app page can sync with: the box's import record, else the adapter it was built from. */
export function syncRepoOf(detail) {
  const r = detail?.importedFrom?.repo ?? detail?.adaptedFrom?.repo;
  return typeof r === "string" && r.trim() ? r.trim() : "";
}

/** How a repo reads in a sentence: no scheme, no trailing `.git`. */
export function repoLabel(repo) {
  return String(repo ?? "").replace(/^[a-z]+:\/\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

export const checkUpdatesLabel = (repo) => tr("Check for updates from {0}", repoLabel(repo));
export const checkingLabel = (repo) => tr("Checking {0}…", repoLabel(repo));
export const upToDateText = (repo) => tr("You already run the latest version from {0}.", repoLabel(repo));
export const proposalTitle = (repo) => tr("Update from {0}", repoLabel(repo));
export const versionLine = (commit) => tr("Version {0}", String(commit).slice(0, 12));

/** The row on the app page. */
export function syncRowHtml(repo) {
  return `
      <button class="card full-width edit-row" id="sd-sync-upstream">
        <span class="edit-row-icon" aria-hidden="true">${refreshIcon}</span>
        <span class="edit-row-body">
          <strong>${escapeHtml(checkUpdatesLabel(repo))}</strong>
          <span class="note">${escapeHtml(SYNC_COPY.footer)}</span>
        </span>
        <span class="build-resume-chevron" aria-hidden="true">›</span>
      </button>`;
}

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** The box's answer, kept to well-formed fields. Null when it isn't one. */
export function readSyncResult(body) {
  if (!body || typeof body !== "object" || typeof body.buildId !== "string" || !body.buildId) return null;
  const p = body.proposal && typeof body.proposal === "object" ? body.proposal : {};
  const capabilityChanges = (Array.isArray(p.capabilityChanges) ? p.capabilityChanges : [])
    .filter((c) => c && typeof c.section === "string")
    .map((c) => ({ section: c.section, added: list(c.added), removed: list(c.removed) }))
    .filter((c) => c.added.length || c.removed.length);
  return {
    buildId: body.buildId,
    candidateCommit: typeof body.candidateCommit === "string" ? body.candidateCommit : "",
    upToDate: body.upToDate === true,
    takeUpstream: list(p.takeUpstream),
    localChanged: list(p.localChanged),
    alreadyApplied: list(p.alreadyApplied),
    conflicts: list(p.conflicts),
    capabilityChanges,
  };
}

/** The counted lines under the version. */
export function summaryLines(r) {
  const out = [trn(r.takeUpstream.length, "{0} file updated from upstream", "{0} files updated from upstream")];
  const kept = r.localChanged.filter((p) => !r.conflicts.includes(p)).length;
  if (kept > 0) out.push(tr("{0} of your changes kept", kept));
  if (r.alreadyApplied.length > 0) out.push(trn(r.alreadyApplied.length, "{0} file already matches", "{0} files already match"));
  return out;
}

export const conflictsHeading = (n) => trn(n, "{0} conflict: your version was kept", "{0} conflicts: your version was kept");

/** The proposal, capability changes first and apart from the code. */
export function proposalHtml(repo, r) {
  const perms = r.capabilityChanges.length
    ? `<div class="card warning" data-sync-capabilities>
        <p class="value">${escapeHtml(SYNC_COPY.permsTitle)}</p>
        <p class="note small">${escapeHtml(SYNC_COPY.permsBody)}</p>
        ${r.capabilityChanges
          .map(
            (c) => `<div class="mt-2" data-sync-section="${escapeHtml(c.section)}">
              <p class="note small"><strong>${escapeHtml(sectionLabel(c.section))}</strong></p>
              ${c.added.length ? `<p class="note small">${escapeHtml(tr("Adds: {0}", c.added.join(", ")))}</p>` : ""}
              ${c.removed.length ? `<p class="note small">${escapeHtml(tr("Removes: {0}", c.removed.join(", ")))}</p>` : ""}
            </div>`,
          )
          .join("")}
      </div>`
    : "";
  const conflicts = r.conflicts.length
    ? `<div class="card" data-sync-conflicts>
        <p class="value">${escapeHtml(conflictsHeading(r.conflicts.length))}</p>
        <ul>${r.conflicts.map((p) => `<li class="mono text-sm">${escapeHtml(p)}</li>`).join("")}</ul>
        <p class="note small">${escapeHtml(SYNC_COPY.conflictsNote)}</p>
      </div>`
    : "";
  return `
    <h3 class="modal-title" data-sync-title>${escapeHtml(proposalTitle(repo))}</h3>
    ${r.candidateCommit ? `<p class="note mono" data-sync-version>${escapeHtml(versionLine(r.candidateCommit))}</p>` : ""}
    ${perms}
    <div data-sync-summary>${summaryLines(r).map((l) => `<p class="modal-message">${escapeHtml(l)}</p>`).join("")}</div>
    ${conflicts}
    <p class="note small" data-sync-footer>${escapeHtml(SYNC_COPY.footer)}</p>
    <div class="row-2 mt-3">
      <button class="secondary" data-sync-choice="discard">${escapeHtml(SYNC_COPY.discard)}</button>
      <button data-sync-choice="review">${escapeHtml(SYNC_COPY.review)}</button>
    </div>`;
}

/** Ask the box for a proposal. Throws a sentence. */
export async function requestSync(client, serviceId, ref) {
  const body = ref ? { ref } : {};
  let out;
  try {
    out = await client.fetch(`/api/build/apps/${encodeURIComponent(serviceId)}/sync`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    if (e?.status === 404) throw new Error(SYNC_COPY.notImported);
    const reason = e?.body && typeof e.body === "object" && typeof e.body.error === "string" ? e.body.error : "";
    throw new Error(reason || humanError(e));
  }
  const r = readSyncResult(out);
  if (!r) throw new Error(humanError(new Error("the server gave no proposal")));
  return r;
}

/** Forget the build the sync opened (an up-to-date check, or Discard). Best effort. */
export async function discardSyncBuild(client, buildId) {
  try {
    await client.fetch(`/api/build/sessions/${encodeURIComponent(buildId)}/discard`, { method: "POST", body: "{}" });
  } catch {
    /* the box forgets unopened builds after 30 days */
  }
}

/** Open the sync's build on the existing git build screen, where Deploy is. */
export async function openSyncBuild(client, buildId) {
  const held = await client.fetch(`/api/build/sessions/${encodeURIComponent(buildId)}`).catch(() => null);
  const state = held?.state ?? { buildId, mode: "git", gitFit: true };
  const { resumeBuildGit } = await import("../views/build-git.js");
  return resumeBuildGit({ buildId, server: client.fqdn, state, fileCount: Array.isArray(held?.files) ? held.files.length : 0 });
}

function overlay(html) {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `<div class="modal-card" role="document" data-sync-sheet>${html}</div>`;
  document.body.appendChild(el);
  document.body.classList.add("modal-open");
  return el;
}

function closeOverlay(el) {
  el.remove();
  if (!document.querySelector(".modal-overlay")) document.body.classList.remove("modal-open");
}

/**
 * The whole flow from the app page: the optional ref, the check, then the proposal (or "already the
 * latest"). Resolves to "review", "discarded", "up-to-date" or "cancelled".
 */
export function openUpstreamSync({ serviceId, repo, client = boxClient() }) {
  return new Promise((resolve) => {
    const el = overlay(`
      <h3 class="modal-title">${escapeHtml(checkUpdatesLabel(repo))}</h3>
      <label class="note small" for="sync-ref">${escapeHtml(SYNC_COPY.refLabel)}</label>
      <input id="sync-ref" class="modal-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <p class="err-text text-sm hidden" data-sync-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-sync-choice="cancel">${escapeHtml(SYNC_COPY.cancel)}</button>
        <button data-sync-choice="check">${escapeHtml(SYNC_COPY.check)}</button>
      </div>`);
    const card = el.querySelector("[data-sync-sheet]");
    let openBuild = null;
    const finish = async (outcome) => {
      if (openBuild && outcome !== "review") await discardSyncBuild(client, openBuild);
      closeOverlay(el);
      resolve(outcome);
    };
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      document.removeEventListener("keydown", onKey);
      void finish(openBuild ? "discarded" : "cancelled");
    };
    document.addEventListener("keydown", onKey);
    const showError = (msg) => {
      const e = card.querySelector("[data-sync-error]");
      if (e) {
        e.textContent = msg;
        e.classList.remove("hidden");
      }
    };
    const run = async () => {
      const ref = (card.querySelector("#sync-ref")?.value ?? "").trim();
      if (ref && (!SYNC_REF_PATTERN.test(ref) || ref.includes(".."))) return showError(SYNC_COPY.badRef);
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const check = card.querySelector('[data-sync-choice="check"]');
      if (check) check.textContent = checkingLabel(repo);
      let r;
      try {
        r = await requestSync(client, serviceId, ref);
      } catch (e) {
        card.querySelectorAll("button").forEach((b) => (b.disabled = false));
        if (check) check.textContent = SYNC_COPY.check;
        return showError(e.message);
      }
      openBuild = r.buildId;
      if (r.upToDate) {
        card.innerHTML = `
          <h3 class="modal-title">${escapeHtml(checkUpdatesLabel(repo))}</h3>
          <p class="modal-message" data-sync-up-to-date>${escapeHtml(upToDateText(repo))}</p>
          <div class="row-2 mt-3"><button data-sync-choice="close">${escapeHtml(SYNC_COPY.close)}</button></div>`;
        card.querySelector('[data-sync-choice="close"]').addEventListener("click", () => void finish("up-to-date"));
        return;
      }
      card.innerHTML = proposalHtml(repo, r);
      card.querySelector('[data-sync-choice="discard"]').addEventListener("click", () => void finish("discarded"));
      card.querySelector('[data-sync-choice="review"]').addEventListener("click", async () => {
        document.removeEventListener("keydown", onKey);
        await finish("review");
        try {
          await openSyncBuild(client, r.buildId);
        } catch (e) {
          toast(humanError(e), "err");
        }
      });
    };
    card.querySelector('[data-sync-choice="cancel"]').addEventListener("click", () => {
      document.removeEventListener("keydown", onKey);
      void finish("cancelled");
    });
    card.querySelector('[data-sync-choice="check"]').addEventListener("click", () => void run());
    card.querySelector("#sync-ref")?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void run();
      }
    });
    queueMicrotask(() => card.querySelector("#sync-ref")?.focus({ preventScroll: true }));
  });
}

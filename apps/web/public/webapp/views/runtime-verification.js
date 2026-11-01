// The server page's "Runtime" section and its "Check it yourself" sheet (release plan G2). Presentation only:
// lib/runtimeVerification.js decides every label; the server computed every value.

import { escapeHtml } from "../lib/util.js";
import { tr } from "../lib/i18n.js";
import {
  flagshipStatus,
  localStatus,
  platformLabel,
  runtimeCommands,
  runtimeNotes,
  runtimeView,
  upstreamStatus,
} from "../lib/runtimeVerification.js";

const PILL = { good: "ok", neutral: "", bad: "err" };
const PAGE_LABEL = "flagshipserver.com/runtime"; // i18n: keep

function pill(id, s) {
  return `<span class="pill ${PILL[s.tone] ?? ""}" id="${id}">${escapeHtml(s.label)}</span>`;
}

function row(label, valueHtml) {
  return `<div class="row"><span class="label">${escapeHtml(label)}</span>${valueHtml}</div>`;
}

const mono = (id, text) => `<span class="value mono small" id="${id}" style="word-break:break-all">${escapeHtml(text ?? "")}</span>`;

/** The section; "" for a server that does not report its runtime. */
export function runtimeSectionHtml(detail) {
  const v = runtimeView(detail);
  if (!v) return "";
  const notes = runtimeNotes(v)
    .map((n) => `<p class="note small${n.tone === "bad" ? " warn-text" : ""}" data-runtime-note>${escapeHtml(n.text)}</p>`)
    .join("");
  return `
    <h2 class="mt-4">${tr("Runtime")}</h2>
    <div class="card" id="runtime-card">
      <p class="note">${tr("Your server runs the official Node.js binary from nodejs.org. Flagship publishes its exact checksum, signed by Flagship's release keys.")}</p>
      ${row(tr("Node.js"), `<span class="value" id="runtime-version">${escapeHtml(v.version)}</span>`)}
      ${row(tr("Platform"), `<span class="value" id="runtime-platform">${escapeHtml(platformLabel(v.target))}</span>`)}
      ${row(tr("Running"), `<span class="value" id="runtime-active">v${escapeHtml(v.activeVersion)}</span>`)}
      ${row(tr("Flagship signature"), pill("runtime-flagship", flagshipStatus(v)))}
      ${row(tr("Node's signature"), pill("runtime-upstream", upstreamStatus(v)))}
      ${row(tr("On this server"), pill("runtime-local", localStatus(v)))}
      ${notes}
      <details class="mt-2" id="runtime-details">
        <summary>${tr("Details")}</summary>
        ${row(tr("Expected checksum (flagshipserver.com)"), mono("runtime-expected", v.flagship.expectedArchiveSha256 ?? v.expectedArchiveSha256))}
        ${row(tr("Expected executable"), mono("runtime-expected-exe", v.expectedExecutableSha256))}
        ${row(tr("Computed on this server"), mono("runtime-local-sha", v.localExecutableSha256 ?? "—"))}
        ${row(tr("Official source"), `<a class="value small" id="runtime-source" href="${escapeHtml(v.officialUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(v.archiveFile)}</a>`)}
      </details>
      <button id="runtime-check-btn" class="secondary full-width mt-2">${tr("Check it yourself")}</button>
    </div>`;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = tr("Copied");
    setTimeout(() => {
      btn.textContent = was;
    }, 1500);
  } catch {
    /* the block stays selectable */
  }
}

export function openRuntimeCheckSheet(v) {
  const groups = runtimeCommands(v);
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.id = "runtime-check-sheet";
  dlg.setAttribute("aria-label", tr("Check it yourself"));
  dlg.innerHTML = `
    <h3 class="modal-title">${tr("Check it yourself")}</h3>
    <p class="modal-message">${tr("Run these on any computer to check the same facts without trusting this app.")}</p>
    ${groups
      .map(
        (g, i) => `
      <p class="caption mt-2">${escapeHtml(g.title)}</p>
      <pre class="journal-output" data-runtime-commands="${i}" style="user-select:text;white-space:pre-wrap;word-break:break-all">${escapeHtml(g.text)}</pre>
      <button class="secondary small" data-runtime-copy="${i}">${tr("Copy")}</button>`,
      )
      .join("")}
    <p class="note small mt-2"><a href="${escapeHtml(v.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(PAGE_LABEL)}</a></p>
    <button class="full-width mt-3" data-close>${tr("Close")}</button>`;
  document.body.appendChild(dlg);
  dlg.showModal?.();
  const done = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  for (const b of dlg.querySelectorAll("[data-runtime-copy]")) {
    b.addEventListener("click", () => void copy(groups[Number(b.getAttribute("data-runtime-copy"))].text, b));
  }
  dlg.querySelector("[data-close]").addEventListener("click", done);
  dlg.addEventListener("cancel", done);
  return dlg;
}

export function wireRuntimeSection(detail) {
  const v = runtimeView(detail);
  const btn = document.getElementById("runtime-check-btn");
  if (!v || !btn) return;
  btn.addEventListener("click", () => openRuntimeCheckSheet(v));
}

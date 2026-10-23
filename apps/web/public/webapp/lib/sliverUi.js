// The sliver's screen: a block under the header with one row per issue. It grows to fit every row
// (it scrolls on a short screen; it never merges or truncates a row). A waiting publisher key gets
// its own high-salience card with the old and new fingerprints and the continuity status, and the
// two choices the plan names: "Trust this new key for this service" and "Reject and pause updates".

import { fetchSliver, fetchWaitingPublisher, rejectPublisherKey, sliverModel, trustPublisherKey } from "./securitySliver.js";
import { getSession } from "./state.js";
import { toast } from "./toast.js";
import { humanError } from "./humanError.js";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const SLIVER_COPY = Object.freeze({
  heading: "Security",
  trust: "Trust this new key for this service",
  reject: "Reject and pause updates",
  lostHistory: "This server lost its list of security notices and started over. Check each service and your recovery settings.",
  chain: "The old key vouched for the new one.",
  noChain: "The old key did not vouch for the new one. Treat this as a different publisher using the same name.",
  warning: "If this is unusual, do not trust the new key. Updates from this publisher stay paused until you decide.",
});

let el = null;
let timer = null;

function ensure() {
  if (el) return el;
  if (typeof document === "undefined") return null;
  el = document.createElement("section");
  el.id = "security-sliver";
  el.className = "sliver hidden";
  el.setAttribute("aria-label", SLIVER_COPY.heading);
  const header = document.querySelector("body > header");
  if (header?.nextSibling) document.body.insertBefore(el, header.nextSibling);
  else document.body.appendChild(el);
  return el;
}

export function rowHtml(m, waiting) {
  const card = m.publisherKey && waiting
    ? `<div class="sliver-key" data-testid="sliver-key">
         <p><strong>Old key</strong> ${esc(waiting.oldFingerprint)} &rarr; <strong>new key</strong> ${esc(waiting.newFingerprint)}</p>
         <p>${esc(waiting.continuity === "valid-chain" ? SLIVER_COPY.chain : SLIVER_COPY.noChain)}</p>
         <p>${esc(SLIVER_COPY.warning)}</p>
         <div class="sliver-actions">
           <button type="button" data-sliver-trust="${esc(m.publisherKey)}">${esc(SLIVER_COPY.trust)}</button>
           <button type="button" class="secondary" data-sliver-reject="${esc(m.publisherKey)}">${esc(SLIVER_COPY.reject)}</button>
         </div>
       </div>`
    : "";
  return `<article class="sliver-row sliver-${esc(m.severity)}${m.active ? "" : " sliver-resolved"}" data-testid="sliver-row">
      <header><span class="sliver-sev">${esc(m.severityLabel)}</span> <span class="sliver-target">${esc(m.target)}</span> <span class="sliver-state">${esc(m.stateLabel)}</span></header>
      <p class="sliver-summary">${esc(m.summary)}</p>
      <p class="sliver-meta">Updated ${esc(m.updated)}${m.deadline ? ` · ${esc(m.deadline)}` : ""}${m.action ? ` · ${esc(m.action)}` : ""}</p>
      ${card}
    </article>`;
}

export async function renderSliver(data, { waitingFor = fetchWaitingPublisher } = {}) {
  const root = ensure();
  if (!root) return;
  const models = sliverModel(data?.lines);
  if (models.length === 0 && !data?.lostHistory) {
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  const waiting = new Map();
  for (const m of models) {
    if (!m.publisherKey) continue;
    try {
      const info = await waitingFor(m.publisherKey);
      if (info?.waiting && !info.waiting.rejected) waiting.set(m.publisherKey, info.waiting);
    } catch { /* the row still shows; the card needs the box */ }
  }
  root.className = "sliver";
  root.innerHTML = `${data?.lostHistory ? `<p class="sliver-lost">${esc(SLIVER_COPY.lostHistory)}</p>` : ""}${models.map((m) => rowHtml(m, waiting.get(m.publisherKey ?? ""))).join("")}`;
  root.querySelectorAll("[data-sliver-trust]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await trustPublisherKey(b.getAttribute("data-sliver-trust"));
        toast("Key trusted for this service", "ok");
        void refresh();
      } catch (e) {
        toast(humanError(e), "err");
      }
    }),
  );
  root.querySelectorAll("[data-sliver-reject]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await rejectPublisherKey(b.getAttribute("data-sliver-reject"));
        toast("Updates paused for this service", "ok");
        void refresh();
      } catch (e) {
        toast(humanError(e), "err");
      }
    }),
  );
}

export async function refresh() {
  try {
    if (!getSession().umk) return;
    const data = await fetchSliver();
    if (data) await renderSliver(data);
  } catch { /* a box that does not have it yet shows nothing */ }
}

export function initSliverUi() {
  void refresh();
  if (timer === null && typeof setInterval === "function") timer = setInterval(() => void refresh(), 60_000);
}

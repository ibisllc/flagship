// The "Your link" field on a service page (docs/named-links.md).
//
// Shows `voi.ci/<name>` as an editable field. Until an admin picks a custom
// name it holds the service's random code, so the page never says "code".
// `linkMessage` is pure (typed text + the link state + the last `.com` check →
// one line and what may be done); `bindLinkField` is the DOM around it.

import { tr } from "./i18n.js";
import { escapeHtml } from "./util.js";
import { toast } from "./toast.js";
import { inlineConfirm } from "./modal.js";
import { formatWhen } from "./dateFormat.js";
import { voiciNameProblem, checkVoiciName, listVoiciNames, saveVoiciName, VoiciNameError } from "./voiciName.js";

const DEBOUNCE_MS = 400;
const DAY_MS = 86_400_000;

/**
 * @param {object} p
 * @param {string} p.typed       what the field holds
 * @param {string} p.current     the name the service shows now (custom name or random code)
 * @param {object} p.link        `{name, held, limit, changesLeft, nextChangeAt, releasesAt}`
 * @param {object|null} p.check  the last `.com` answer for `typed`, or null while unknown
 * @param {boolean} p.admin
 * @returns {{tone:"ok"|"bad"|"info"|"", text:string, action:null|"dibs"|"free-up", canSave:boolean}}
 */
export function linkMessage({ typed, current, link, check, admin, now = Date.now() }) {
  const none = { tone: "", text: "", action: null, canSave: false };
  if (!admin) return { ...none, tone: "info", text: tr("Only an admin device can change this") };
  if (link.changesLeft <= 0) {
    return { ...none, tone: "bad", text: tr("Next change {0}", formatWhen(link.nextChangeAt ?? now + DAY_MS)) };
  }
  if (typed === current || typed === "") return none;
  const problem = voiciNameProblem(typed);
  if (problem === "characters") return { ...none, tone: "bad", text: tr("Letters, numbers and hyphens only") };
  if (problem === "too-short") return { ...none, tone: "bad", text: tr("At least 4 characters") };
  if (problem === "too-long") return { ...none, tone: "bad", text: tr("At most 40 characters") };
  if (link.held >= link.limit && !link.name) {
    return { ...none, tone: "bad", text: tr("All {0} names in use", link.limit), action: "free-up" };
  }
  if (!check) return none;
  switch (check.status) {
    case "available":
      return { tone: "ok", text: tr("Available"), action: null, canSave: true };
    case "current":
      return none;
    case "invalid":
      return { ...none, tone: "bad", text: tr("Letters, numbers and hyphens only") };
    case "reserved":
      return { ...none, tone: "bad", text: tr("Reserved") };
    case "taken":
      return { ...none, tone: "bad", text: tr("Taken") };
    case "dibs":
      return { ...none, tone: "info", text: tr("Reserved for the owner of {0}", check.domain), action: "dibs" };
    default:
      return { ...none, tone: "bad", text: tr("Couldn't check {0}. Try again.", typed) };
  }
}

/** The sentence for a refusal from the save call. */
export function refusalMessage(e, typed) {
  switch (e.code) {
    case "taken":
      return tr("Taken");
    case "reserved":
      return tr("Reserved");
    case "invalid":
      return tr("Letters, numbers and hyphens only");
    case "dibs":
      return tr("Reserved for the owner of {0}", e.data.domain);
    case "dibs-unchecked":
      return tr("Couldn't check {0}. Try again.", typed);
    case "change-limit":
      return tr("Next change {0}", formatWhen(e.data.nextChangeAt));
    case "name-limit":
      return tr("All {0} names in use", e.data.limit);
    case "rate-limited":
      return tr("Too many changes today");
    case "not-admin":
      return tr("Only an admin device can change this");
    default:
      return tr("Couldn't save. Try again.");
  }
}

/** The field's markup. `value` is the custom name, else the random code. */
export function renderLinkField({ link, shortCode, admin }) {
  const value = link?.name ?? shortCode ?? "";
  const note = link?.name && link.releasesAt
    ? `<div class="faint-sm" data-lf="note">${tr("Unused for 60 days, it's released.")}</div>`
    : "";
  return `
    <div class="link-field" data-lf="root">
      <label class="label-tiny" for="lf-input">${tr("Your link")}</label>
      <div class="link-field-row">
        <span class="mono link-field-prefix">${"voi.ci/"}</span>
        <input id="lf-input" class="mono" data-lf="input" value="${escapeHtml(value)}" maxlength="40"
          autocapitalize="off" autocomplete="off" spellcheck="false" ${admin ? "" : "readonly"}>
        <button class="ghost" data-copy="https://voi.ci/${escapeHtml(value)}" aria-label="${tr("Copy short link")}">📋</button>
      </div>
      <div class="link-field-msg muted-sm" data-lf="msg" role="status" aria-live="polite"></div>
      <div class="link-field-actions" data-lf="actions"></div>
      <div data-lf="free"></div>
      ${note}
    </div>`;
}

/**
 * @param {HTMLElement} root     the element renderLinkField produced
 * @param {object} o
 * @param {string} o.username
 * @param {string} o.serviceId
 * @param {object} o.link        starting link state
 * @param {string} o.shortCode
 * @param {boolean} o.admin
 * @param {(link:object)=>void} o.onChanged
 * @param {(name:string)=>Promise<void>|void} [o.onDibs]   hand-off to the domain proof
 */
export function bindLinkField(root, o, deps = {}) {
  const input = root.querySelector('[data-lf="input"]');
  const msg = root.querySelector('[data-lf="msg"]');
  const actions = root.querySelector('[data-lf="actions"]');
  const free = root.querySelector('[data-lf="free"]');
  const check = deps.checkVoiciName ?? checkVoiciName;
  const save = deps.saveVoiciName ?? saveVoiciName;
  const list = deps.listVoiciNames ?? listVoiciNames;
  const confirm = deps.inlineConfirm ?? inlineConfirm;
  let link = o.link;
  let timer = null;
  let seq = 0;
  let last = null;

  const current = () => link.name ?? o.shortCode;
  const typedNow = () => input.value.trim().toLowerCase();

  function paint(m) {
    msg.textContent = m.text;
    msg.className = `link-field-msg muted-sm ${m.tone ? `lf-${m.tone}` : ""}`;
    actions.innerHTML = "";
    const add = (label, cls, fn) => {
      const b = document.createElement("button");
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", fn);
      actions.appendChild(b);
    };
    if (m.canSave) add(tr("Save"), "pill", () => commit(typedNow()));
    if (m.action === "dibs") add(tr("I own it"), "pill", () => o.onDibs?.(typedNow()));
    if (m.action === "free-up") add(tr("Free one up"), "pill", openFreeUp);
    if (link.name && o.admin && typedNow() === link.name) {
      add(tr("Use default"), "ghost", () => commit(""));
    }
  }

  function refresh() {
    const typed = typedNow();
    paint(linkMessage({ typed, current: current(), link, check: last?.name === typed ? last.result : null, admin: o.admin }));
  }

  async function runCheck() {
    const typed = typedNow();
    const base = linkMessage({ typed, current: current(), link, check: { status: "available" }, admin: o.admin });
    if (!base.canSave) return refresh();
    const mine = ++seq;
    try {
      const result = await check({ username: o.username, serviceId: o.serviceId, name: typed });
      if (mine !== seq) return;
      last = { name: typed, result };
    } catch (e) {
      if (mine !== seq) return;
      last = { name: typed, result: { status: "error" } };
    }
    refresh();
  }

  async function commit(name) {
    if (link.name) {
      const ok = await confirm({
        title: tr("Replace voi.ci/{0}? It stops working now and can't be taken back.", link.name),
        okLabel: tr("Replace"),
        cancelLabel: tr("Cancel"),
        danger: true,
      }).catch(() => false);
      if (!ok) return;
    }
    try {
      link = await save({ username: o.username, serviceId: o.serviceId, name });
      last = null;
      input.value = link.name ?? o.shortCode;
      o.onChanged?.(link);
      refresh();
    } catch (e) {
      if (!(e instanceof VoiciNameError)) {
        toast(tr("Couldn't save. Try again."), "err");
        return;
      }
      msg.textContent = refusalMessage(e, name);
      msg.className = "link-field-msg muted-sm lf-bad";
    }
  }

  async function openFreeUp() {
    let names = [];
    try {
      names = await list(o.username);
    } catch {
      toast(tr("Couldn't save. Try again."), "err");
      return;
    }
    free.innerHTML = names
      .map(
        (n, i) => `<div class="row"><span class="mono">${"voi.ci/"}${escapeHtml(n.name)}</span>
          <button class="ghost" data-i="${i}">${tr("Use default")}</button></div>`,
      )
      .join("");
    free.querySelectorAll("button[data-i]").forEach((b) =>
      b.addEventListener("click", async () => {
        const n = names[Number(b.dataset.i)];
        const sure = await confirm({
          title: tr("Replace voi.ci/{0}? It stops working now and can't be taken back.", n.name),
          okLabel: tr("Replace"),
          cancelLabel: tr("Cancel"),
          danger: true,
        }).catch(() => false);
        if (!sure) return;
        try {
          const next = await save({ username: o.username, serviceId: n.serviceId, name: "" });
          if (n.serviceId === o.serviceId) link = next;
          else link = { ...link, held: Math.max(0, link.held - 1) };
          free.innerHTML = "";
          o.onChanged?.(link);
          refresh();
        } catch (e) {
          msg.textContent = e instanceof VoiciNameError ? refusalMessage(e, n.name) : tr("Couldn't save. Try again.");
          msg.className = "link-field-msg muted-sm lf-bad";
        }
      }),
    );
  }

  input.addEventListener("input", () => {
    input.value = input.value.toLowerCase();
    clearTimeout(timer);
    last = null;
    refresh();
    timer = setTimeout(runCheck, DEBOUNCE_MS);
  });
  refresh();
  return { refresh, getLink: () => link };
}

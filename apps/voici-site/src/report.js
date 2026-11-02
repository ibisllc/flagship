// "Report this page" (docs/voici-and-messages.md §9.2): a reason, an optional note, sent to Flagship. Anonymous,
// or signed with this browser's key when the visitor is signed in to this page (they are told which).

import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "./i18n.js";
import { closeSheet, openSheet } from "./sheet.js";
import { visitorName } from "./messages.js";

export const REPORT_REASONS = () => [
  ["spam", t("Spam")],
  ["harassment", t("Harassment or bullying")],
  ["impersonation", t("Pretending to be someone else")],
  ["illegal", t("Illegal content")],
  ["other", t("Something else")],
];

/** ctx = {doc, cfg, lib, store, page: {username, index}}. */
export async function openReport(ctx) {
  const { doc, lib, cfg, page } = ctx;
  const session = await lib.loadVoiciSession(ctx.store, page.index.pageId, { origin: cfg.origin });
  const sheet = openSheet(doc, { title: t("Report this page") });
  const reasons = REPORT_REASONS();
  const radios = reasons.map(([value, label], i) =>
    h(doc, "label", { class: "choice" }, h(doc, "input", { type: "radio", name: "reason", value, checked: i === 0 }), h(doc, "span", {}, label)),
  );
  const note = h(doc, "textarea", { class: "input", rows: 3, maxlength: 1000, id: "report-note", placeholder: t("What's wrong? (optional)") });
  const error = h(doc, "p", { class: "form-error", role: "alert", hidden: true });
  const submit = h(doc, "button", { class: "btn btn-primary", type: "submit" }, t("Send report"));
  const form = h(
    doc,
    "form",
    { class: "report-form", on: { submit: (e) => (e.preventDefault(), send()) } },
    h(doc, "fieldset", { class: "choices" }, h(doc, "legend", { class: "label" }, t("Why are you reporting it?")), radios),
    h(doc, "label", { class: "label", for: "report-note" }, t("Note")),
    note,
    error,
    h(doc, "p", { class: "fine" }, session ? t("Sent as {0}, the name this page knows you by.", visitorName(lib, session.pseudonymPub)) : t("Sent without your name. Flagship reviews every report.")),
    h(doc, "div", { class: "sheet-actions" }, h(doc, "button", { class: "btn btn-secondary", type: "button", on: { click: closeSheet } }, t("Cancel")), submit),
  );
  replace(sheet.body, form);

  async function send() {
    const reason = form.querySelector('input[name="reason"]:checked')?.getAttribute("value") ?? "other";
    const n = lib.protocol.prepareVoiciText("reportNote", note.value);
    if (!n.ok) {
      error.textContent = n.code === "too-long" ? t("Keep the note under 500 characters.") : t("The note has characters that can't be sent.");
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const body = await lib.buildPageReport({ username: page.username, seq: page.index.seq, reason, note: n.text, session });
      const r = await lib.postPageReport(body, { apiBase: cfg.apiBase });
      if (!r.ok) {
        error.textContent =
          r.code === "rate-limited" ? t("Too many reports from your network. Try again later.") : t("Couldn't send the report. Try again.");
        error.hidden = false;
        return;
      }
      replace(
        sheet.body,
        h(
          doc,
          "div",
          { class: "done" },
          h(doc, "div", { class: "state-icon" }, icon(doc, "check")),
          h(doc, "p", { class: "lede" }, t("Thanks. Flagship will look at this page.")),
          h(doc, "button", { class: "btn btn-secondary", type: "button", on: { click: closeSheet } }, t("Close")),
        ),
      );
    } finally {
      submit.disabled = false;
    }
  }
}

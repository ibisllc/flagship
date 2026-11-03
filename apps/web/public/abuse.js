// The report form on /abuse (docs/abuse-handling.md §1). A separate file so the page keeps a CSP without inline
// script. The lines it shows live in the page (#abuse-messages), so the page holds all of its text.
(function () {
  "use strict";
  var form = document.getElementById("abuse-form");
  var out = document.getElementById("abuse-out");
  if (!form || !out) return;

  function msg(key, arg) {
    var src = document.querySelector('#abuse-messages [data-msg="' + key + '"]');
    if (!src) return key;
    var c = src.cloneNode(true);
    var slot = c.querySelector("[data-arg]");
    if (slot) slot.textContent = String(arg == null ? "" : arg);
    return c.textContent.replace(/\s+/g, " ").trim();
  }

  function show(kind, text) {
    out.className = "out" + (kind ? " " + kind : "");
    out.textContent = text;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var subject = String(data.get("subject") || "").trim();
    if (!subject) {
      show("err", msg("missing"));
      return;
    }
    var contact = String(data.get("contact") || "").trim();
    var body = {
      kind: data.get("kind") === "link" ? "link" : "app",
      subject: subject,
      reason: String(data.get("reason") || "other"),
      note: String(data.get("note") || ""),
      contact: contact || null,
    };
    show("", msg("sending"));
    fetch("/api/abuse/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, body: j }; });
      })
      .then(function (r) {
        if (r.ok) {
          show("ok", msg("ok", r.body.reportId));
          form.reset();
        } else if (r.status === 404 && r.body.code === "not-flagship") show("err", msg("not-flagship"));
        else if (r.status === 400) show("err", msg("malformed"));
        else if (r.status === 429) show("err", msg("rate-limited"));
        else show("err", msg("failed", r.status));
      })
      .catch(function () {
        show("err", msg("network"));
      });
  });
})();

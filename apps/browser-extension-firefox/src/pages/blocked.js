// The warning page a pin mismatch leads to. There is deliberately no "continue anyway": a Flagship box serving a
// certificate it didn't sign is the interception the pin exists to stop.
import { t, localize } from "../lib/i18n.js";
import { isFlagshipHost } from "../lib/pinCheck.js";

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const host = q.get("host") ?? "";
const server = q.get("server") ?? "";
const original = q.get("url") ?? "";
const fp = (h) => (/^[0-9a-f]{64}$/.test(h) ? h.match(/.{1,4}/g).join(" ") : t("blockedUnknownFingerprint"));

document.addEventListener("DOMContentLoaded", () => {
  localize();
  $("lead").textContent = t("blockedLead", host, server);
  $("expected").textContent = fp(q.get("expected") ?? "");
  $("served").textContent = fp(q.get("served") ?? "");
  $("back").addEventListener("click", () => history.length > 1 ? history.back() : window.close());
  $("recheck").addEventListener("click", async () => {
    $("recheck").disabled = true;
    const outcome = server ? await browser.runtime.sendMessage({ type: "refresh", serverDomain: server }).catch(() => null) : null;
    let target = null;
    try { target = new URL(original); } catch { /* nothing to retry */ }
    if (outcome?.ok && target && target.protocol === "https:" && isFlagshipHost(target.hostname)) {
      location.replace(target.href);
      return;
    }
    $("recheck-result").textContent = t("blockedStillWrong");
    $("recheck").disabled = false;
  });
});

// "This server needs an update" (owner decision 2026-11-02): `/pods` `updateRequired` marks a box that runs a
// release from before the one `.com` needs (a 0.2 box under 0.3, control-plane boxUpdateRequired.ts). Its
// certificate can't renew, so it goes dark when the one it holds runs out. The server page shows this banner and
// moves its Software update card right under it.
import { tr, dateLocale } from "./i18n.js";
import { escapeHtml } from "./util.js";

/** The line under the title: when the certificate runs out, if `.com` knows. */
export function updateRequiredDetail(view, locale = dateLocale()) {
  const ms = view?.certificateExpiresAt;
  if (typeof ms !== "number" || !(ms > 0)) return tr("Its certificate can't be renewed until it is updated.");
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(ms));
  return tr("Its certificate can't be renewed and runs out on {0}. Update it before then.", date);
}

/** The banner for a `/pods` row, or "" when it needs no update (or is revoked). */
export function updateRequiredBannerHtml(pod, locale = dateLocale()) {
  if (!pod?.updateRequired || pod.revokedAt) return "";
  return `<div class="card warning" id="update-required-banner" data-testid="sd-update-required" role="status">
      <p class="warn-text"><strong>${escapeHtml(tr("This server needs an update to keep working with Flagship 0.3"))}</strong></p>
      <p class="note mt-1" data-testid="sd-update-required-detail">${escapeHtml(updateRequiredDetail(pod.updateRequired, locale))}</p>
    </div>`;
}

/**
 * "Share update results" (docs/runbooks/canary.md, docs/support/update-rollback.md §4-5): the
 * owner's choice to let the server send Flagship one anonymous note per update. The box keeps the
 * choice (GET/POST /api/update-reports, owner sessions only; `{ share: boolean }`). Off until the
 * owner turns it on.
 */
import { tr } from "./i18n.js";

export const UPDATE_REPORTS_PATH = "/api/update-reports";

export function shareUpdateResultsTitle() {
  return tr("Share update results");
}

export function shareUpdateResultsDetail() {
  return tr("Send Flagship an anonymous note after each update: the release, whether it started cleanly and whether it went back. Never your server's name, your account or anything about your apps.");
}

/** The box's current choice. `fetchBox(path, init)` is the owner session's box fetch. */
export async function readUpdateReports(fetchBox) {
  const body = await fetchBox(UPDATE_REPORTS_PATH);
  return { share: body?.share === true, source: body?.source === "owner" ? "owner" : "default" };
}

export async function setUpdateReports(fetchBox, share) {
  const body = await fetchBox(UPDATE_REPORTS_PATH, { method: "POST", body: JSON.stringify({ share: share === true }) });
  return { share: body?.share === true };
}

/** The switch for the server page's update card; hidden until the box answers. */
export function updateReportsSwitchHtml() {
  return `<div class="hidden mt-2" id="update-reports">
          <label class="share-opt">
            <input type="checkbox" role="switch" id="update-reports-switch" disabled />
            <span>${tr("Share update results")}</span>
          </label>
          <p class="note small mt-1">${tr("Send Flagship an anonymous note after each update: the release, whether it started cleanly and whether it went back. Never your server's name, your account or anything about your apps.")}</p>
        </div>`;
}

/**
 * Load the box's choice into the switch and send each change. A box that refuses this session (a
 * Remote or co-manager session) or has no such setting keeps the switch hidden.
 */
export async function wireUpdateReportsSwitch({ fetchBox, root, onError }) {
  const wrap = root?.querySelector?.("#update-reports");
  const input = root?.querySelector?.("#update-reports-switch");
  if (!wrap || !input) return;
  let current;
  try {
    current = (await readUpdateReports(fetchBox)).share;
  } catch {
    return;
  }
  input.checked = current;
  input.disabled = false;
  wrap.classList.remove("hidden");
  input.addEventListener("change", async () => {
    const want = input.checked;
    input.disabled = true;
    try {
      current = (await setUpdateReports(fetchBox, want)).share;
    } catch (e) {
      onError?.(e);
    } finally {
      input.checked = current;
      input.disabled = false;
    }
  });
}

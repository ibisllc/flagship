// Multi-pod switcher — pure, DOM-free logic (parity with iOS
// FlagshipUI/Components/PodSwitcher.swift + ServicesTab's
// `if app.pods.count > 1 { PodSwitcher(...) }`).
//
// iOS exposes the switcher ONLY when the user owns more than one pod, lists
// each pod, and marks the currently-selected one with a checkmark. The
// webapp's "current pod" is whichever pod the active pod base URL
// (lib/api.js getPodBaseUrl) points at — switching = setPodBaseUrl(...) to
// the chosen pod, then re-render the per-pod-scoped list.
//
// This module holds the selection model only — no DOM, no fetch — so the
// rule ("show iff >1 pod", which option is selected, what switching does to
// the active selection) is unit-testable in isolation. The view layer
// (views/services-list.js) renders + wires it.

/** The pod base URL for a pod is `https://<serverDomain>`. A pod is
 *  identified, like iOS, by its FQDN; this is the only derivation the
 *  switcher needs to map a pod ↔ the active-pod slot in lib/api.js. */
export function podBaseUrlFor(serverDomain) {
  const host = String(serverDomain ?? "").trim();
  return host ? `https://${host}` : "";
}

/** Host portion of a pod base URL (case-folded, scheme + trailing slash
 *  stripped) so we can compare the active base URL to a pod's fqdn without
 *  caring about a stray slash or scheme casing. Best-effort: a non-URL
 *  string falls back to a manual strip. */
export function hostOfBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
  }
}

/** The short display name for a pod — the first DNS label of
 *  `<server>.<user>.flagship.services` (mirrors home.js serverShortName /
 *  iOS PodInfo.name). Falls back to the raw fqdn. */
export function podShortName(serverDomain) {
  const s = String(serverDomain ?? "").trim();
  const first = s.split(".")[0];
  return first || s;
}

/**
 * Build the pod-switcher model from the user's online pods + the active pod
 * base URL.
 *
 * `pods` is the value set the webapp already has: the entries of the
 * `statusByDomain` map returned by home.js `fetchPodInventory` (each carries
 * a `serverDomain`; `state` is "online" for every registered pod). We accept
 * either that map or a plain array. Only entries WITH a serverDomain count —
 * a malformed/pending entry can't be a switch target.
 *
 * Returns `{ show, options, selectedBaseUrl }`:
 *   - `show`: true iff there is MORE THAN ONE selectable pod (exact iOS rule
 *     `app.pods.count > 1`). With 0 or 1 pod the switcher is hidden.
 *   - `options`: `[{ podId, name, fqdn, baseUrl, selected }]`, de-duped on
 *     fqdn and sorted by display name for a stable order. Exactly one option
 *     is `selected` when the active base URL matches a pod; if it matches
 *     none (e.g. paired to a box not in the directory yet), the first option
 *     is selected so the control always shows a current value (iOS likewise
 *     defaults the current pod).
 *   - `selectedBaseUrl`: the base URL of the selected option ("" when none).
 *
 * @param {Map<string,{serverDomain?:string}>|Array<{serverDomain?:string}>} pods
 * @param {string} activeBaseUrl  the current pod base URL (api.getPodBaseUrl())
 */
export function buildPodSwitcherModel(pods, activeBaseUrl) {
  const list = pods instanceof Map ? [...pods.values()] : Array.isArray(pods) ? pods : [];
  // De-dupe on the normalized fqdn, keep only entries that name a pod.
  const seen = new Set();
  const opts = [];
  for (const p of list) {
    const fqdn = String(p?.serverDomain ?? "").trim();
    if (!fqdn) continue;
    const key = fqdn.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    opts.push({
      podId: `pod-${key}`,
      name: podShortName(fqdn),
      fqdn,
      baseUrl: podBaseUrlFor(fqdn),
      selected: false,
    });
  }
  // Stable order: by display name, then fqdn (a tie-breaker so two pods that
  // share a first label don't reorder between renders).
  opts.sort((a, b) => a.name.localeCompare(b.name) || a.fqdn.localeCompare(b.fqdn));

  const activeHost = hostOfBaseUrl(activeBaseUrl);
  let selectedIdx = opts.findIndex((o) => o.fqdn.toLowerCase() === activeHost);
  // No match (paired to a box not in the directory, or empty active URL):
  // default to the first pod so there's always a current value to display.
  if (selectedIdx < 0 && opts.length > 0) selectedIdx = 0;
  if (selectedIdx >= 0) opts[selectedIdx].selected = true;

  return {
    show: opts.length > 1,
    options: opts,
    selectedBaseUrl: selectedIdx >= 0 ? opts[selectedIdx].baseUrl : "",
  };
}

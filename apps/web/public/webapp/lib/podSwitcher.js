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
 * The synthetic "All servers" pseudo-option's stable base URL sentinel. It is
 * NOT a real pod URL — it's the empty string, which is also exactly what
 * `getPodBaseUrl()` returns when no single pod is scoped (api.js falls back to
 * same-origin). So selecting "All servers" is `setPodBaseUrl("")` — clearing
 * the active-pod scope — and the model marks it selected when the active base
 * URL doesn't match any specific pod.
 */
export const ALL_PODS_BASE_URL = "";

/**
 * Determine the LEADER pod's fqdn from a pod list, using the SAME convention
 * the control plane uses for tier-2 canonical routing (serviceRename.ts:
 * `liveServers[0]` — the earliest-registered non-revoked server). Pure +
 * DOM-free so the view layer can pass it into `buildPodSwitcherModel`.
 *
 * Returns the leader's fqdn (lower-cased) or "" if none.
 *
 * @param {Map<string,object>|Array<object>} pods
 */
export function leaderFqdnOf(pods) {
  const list = pods instanceof Map ? [...pods.values()] : Array.isArray(pods) ? pods : [];
  const live = list
    .filter((p) => String(p?.serverDomain ?? "").trim() && p?.revokedAt == null)
    .sort((a, b) => (a?.registeredAt ?? 0) - (b?.registeredAt ?? 0));
  return live.length ? String(live[0].serverDomain).trim().toLowerCase() : "";
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
 * The FIRST option is always the synthetic **"All servers"** pseudo-option
 * (`isAll: true`, `baseUrl: ""`). "All servers" semantics: no single-pod
 * scoping — `setPodBaseUrl("")` clears the active-pod slot so per-pod-scoped
 * views show their default (unscoped) data. It is `selected` when the active
 * base URL matches NO specific pod (e.g. empty active URL). Selecting a
 * specific pod scopes to it (the existing setPodBaseUrl behavior).
 *
 * Returns `{ show, options, all, selectedBaseUrl }`:
 *   - `show`: true iff there is MORE THAN ONE selectable pod (exact iOS rule
 *     `app.pods.count > 1`). With 0 or 1 pod the switcher is hidden.
 *   - `options`: `[{ podId, name, fqdn, baseUrl, selected, isLeader, isAll }]`.
 *     Index 0 is the "All servers" pseudo-option; the rest are the de-duped
 *     pods sorted by display name. The leader pod (earliest-registered
 *     non-revoked) is marked `isLeader: true`. Exactly one option is
 *     `selected`: the matching pod when the active base URL names one, else
 *     "All servers".
 *   - `all`: the "All servers" option (same object as `options[0]`).
 *   - `selectedBaseUrl`: the base URL of the selected option ("" for "All").
 *
 * @param {Map<string,object>|Array<object>} pods
 * @param {string} activeBaseUrl  the current pod base URL (api.getPodBaseUrl())
 * @param {string} [leaderFqdn]  the leader pod's fqdn; defaults to
 *   `leaderFqdnOf(pods)` so the caller need not compute it.
 */
export function buildPodSwitcherModel(pods, activeBaseUrl, leaderFqdn) {
  const list = pods instanceof Map ? [...pods.values()] : Array.isArray(pods) ? pods : [];
  const leader = String(leaderFqdn ?? leaderFqdnOf(pods)).trim().toLowerCase();
  // De-dupe on the normalized fqdn, keep only entries that name a pod.
  const seen = new Set();
  const podOpts = [];
  for (const p of list) {
    const fqdn = String(p?.serverDomain ?? "").trim();
    if (!fqdn) continue;
    const key = fqdn.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    podOpts.push({
      podId: `pod-${key}`,
      name: podShortName(fqdn),
      fqdn,
      baseUrl: podBaseUrlFor(fqdn),
      selected: false,
      isLeader: key === leader,
      isAll: false,
    });
  }
  // Stable order: by display name, then fqdn (a tie-breaker so two pods that
  // share a first label don't reorder between renders).
  podOpts.sort((a, b) => a.name.localeCompare(b.name) || a.fqdn.localeCompare(b.fqdn));

  // The "All servers" pseudo-option is always first.
  const allOption = {
    podId: "pod-all",
    name: "All servers",
    fqdn: "",
    baseUrl: ALL_PODS_BASE_URL,
    selected: false,
    isLeader: false,
    isAll: true,
  };
  const opts = [allOption, ...podOpts];

  const activeHost = hostOfBaseUrl(activeBaseUrl);
  // A specific pod is selected when the active base URL names one; otherwise
  // "All servers" (no single-pod scope) is the current selection.
  const podIdx = podOpts.findIndex((o) => o.fqdn.toLowerCase() === activeHost);
  if (podIdx >= 0) {
    podOpts[podIdx].selected = true;
  } else {
    allOption.selected = true;
  }
  const selected = opts.find((o) => o.selected);

  return {
    show: podOpts.length > 1,
    options: opts,
    all: allOption,
    selectedBaseUrl: selected ? selected.baseUrl : "",
  };
}

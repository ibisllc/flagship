import { describe, expect, it } from "vitest";
import {
  buildPodSwitcherModel,
  podBaseUrlFor,
  hostOfBaseUrl,
  podShortName,
  leaderFqdnOf,
  ALL_PODS_BASE_URL,
} from "../public/webapp/lib/podSwitcher.js";

// Helper: the real pod options (excluding the synthetic "All servers" first
// option) so the existing assertions about "the pods" stay precise.
function podOptions(model: { options: Array<{ isAll: boolean }> }) {
  return model.options.filter((o) => !o.isAll);
}

/**
 * Multi-pod switcher pure logic (parity with iOS
 * FlagshipUI/Components/PodSwitcher.swift + ServicesTab's
 * `if app.pods.count > 1 { PodSwitcher(...) }`). The DOM-free model that
 * services-list.js renders: shown ONLY with >1 pod, each online pod is an
 * option, the current pod (the one the active pod base URL points at) is
 * marked selected, and switching points the active selection at another pod.
 *
 * These import the SAME lib/podSwitcher.js module that ships to the browser.
 */

// A pod entry mirrors a `statusByDomain` map value from home.js
// fetchPodInventory — `serverDomain` is load-bearing; `registeredAt` /
// `revokedAt` drive leader derivation (earliest-registered non-revoked).
let registeredSeq = 0;
function pod(serverDomain: string, extra: Record<string, unknown> = {}) {
  // lastReported marks the pod as having come online — leaderFqdnOf skips
  // never-online pods (parity with iOS/Android); override lastReported:null to
  // model a still-provisioning box.
  return { serverDomain, state: "online" as const, registeredAt: ++registeredSeq, revokedAt: null, lastReported: 1, ...extra };
}

const HOME = "home.alice.flagship.services";
const WORK = "work.alice.flagship.services";
const NAS = "nas.alice.flagship.services";

describe("podSwitcher — small pure helpers", () => {
  it("derives the pod base URL as https://<serverDomain>", () => {
    expect(podBaseUrlFor(HOME)).toBe(`https://${HOME}`);
    expect(podBaseUrlFor("")).toBe("");
    expect(podBaseUrlFor(undefined as unknown as string)).toBe("");
  });

  it("extracts the host from a base URL (scheme + trailing slash agnostic)", () => {
    expect(hostOfBaseUrl(`https://${HOME}`)).toBe(HOME);
    expect(hostOfBaseUrl(`https://${HOME}/`)).toBe(HOME);
    expect(hostOfBaseUrl(`HTTPS://${HOME.toUpperCase()}`)).toBe(HOME);
    expect(hostOfBaseUrl("")).toBe("");
  });

  it("uses the first DNS label as the short display name", () => {
    expect(podShortName(HOME)).toBe("home");
    expect(podShortName("nas")).toBe("nas");
    expect(podShortName("")).toBe("");
  });
});

describe("podSwitcher — visibility mirrors iOS `pods.count > 1`", () => {
  it("is HIDDEN with zero pods", () => {
    const m = buildPodSwitcherModel([], "");
    expect(m.show).toBe(false);
    // Only the synthetic "All servers" option (no real pods).
    expect(podOptions(m)).toHaveLength(0);
  });

  it("is HIDDEN with exactly one pod", () => {
    const m = buildPodSwitcherModel([pod(HOME)], podBaseUrlFor(HOME));
    expect(m.show).toBe(false);
    expect(podOptions(m)).toHaveLength(1);
    // The single pod is the current selection (active URL names it).
    expect(podOptions(m)[0]!.selected).toBe(true);
  });

  it("is VISIBLE with two or more pods", () => {
    const m = buildPodSwitcherModel([pod(HOME), pod(WORK)], podBaseUrlFor(HOME));
    expect(m.show).toBe(true);
    expect(podOptions(m)).toHaveLength(2);
  });

  it("accepts a Map (statusByDomain) as well as an array", () => {
    const map = new Map([
      [HOME.toLowerCase(), pod(HOME)],
      [WORK.toLowerCase(), pod(WORK)],
    ]);
    const m = buildPodSwitcherModel(map, podBaseUrlFor(WORK));
    expect(m.show).toBe(true);
    expect(podOptions(m).map((o) => o.fqdn).sort()).toEqual([HOME, WORK].sort());
  });

  it("ignores entries without a serverDomain (not a switch target)", () => {
    const m = buildPodSwitcherModel(
      [pod(HOME), { state: "pending" } as never, pod(WORK)],
      podBaseUrlFor(HOME),
    );
    expect(podOptions(m)).toHaveLength(2);
  });

  it("de-dupes on fqdn (case-insensitive)", () => {
    const m = buildPodSwitcherModel(
      [pod(HOME), pod(HOME.toUpperCase()), pod(WORK)],
      podBaseUrlFor(HOME),
    );
    expect(podOptions(m)).toHaveLength(2);
  });
});

describe("podSwitcher — 'All servers' pseudo-option", () => {
  it("is always the FIRST option, marked isAll, with an empty base URL", () => {
    const m = buildPodSwitcherModel([pod(HOME), pod(WORK)], podBaseUrlFor(HOME));
    expect(m.options[0]!.isAll).toBe(true);
    expect(m.options[0]!.name).toBe("All servers");
    expect(m.options[0]!.baseUrl).toBe(ALL_PODS_BASE_URL);
    expect(m.options[0]!.baseUrl).toBe("");
    expect(m.all).toBe(m.options[0]);
  });

  it("is SELECTED when no specific pod is scoped (empty active URL)", () => {
    const m = buildPodSwitcherModel([pod(HOME), pod(WORK)], "");
    expect(m.all.selected).toBe(true);
    expect(m.selectedBaseUrl).toBe("");
    // No real pod is selected when "All servers" is the current scope.
    expect(podOptions(m).some((o) => o.selected)).toBe(false);
  });

  it("is SELECTED when the active URL matches no known pod", () => {
    const m = buildPodSwitcherModel(
      [pod(HOME), pod(WORK)],
      "https://other.bob.flagship.services",
    );
    expect(m.all.selected).toBe(true);
  });

  it("is NOT selected when a specific pod is scoped", () => {
    const m = buildPodSwitcherModel([pod(HOME), pod(WORK)], podBaseUrlFor(WORK));
    expect(m.all.selected).toBe(false);
    expect(podOptions(m).find((o) => o.fqdn === WORK)!.selected).toBe(true);
  });

  it("exactly one option is selected (All counts as the selection)", () => {
    const all = buildPodSwitcherModel([pod(HOME), pod(WORK)], "");
    expect(all.options.filter((o) => o.selected)).toHaveLength(1);
    const scoped = buildPodSwitcherModel([pod(HOME), pod(WORK)], podBaseUrlFor(HOME));
    expect(scoped.options.filter((o) => o.selected)).toHaveLength(1);
  });
});

describe("podSwitcher — leader marking", () => {
  it("marks the earliest-registered non-revoked pod as the leader", () => {
    // WORK registered first (lowest registeredAt) → it is the leader.
    const work = pod(WORK); // registeredAt = N
    const home = pod(HOME); // registeredAt = N+1
    const m = buildPodSwitcherModel([home, work], podBaseUrlFor(HOME));
    const leaders = podOptions(m).filter((o) => o.isLeader);
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.fqdn).toBe(WORK);
    // The "All servers" option is never a leader.
    expect(m.all.isLeader).toBe(false);
  });

  it("skips a revoked pod when picking the leader", () => {
    const revoked = pod(WORK, { revokedAt: 999 }); // earliest but revoked
    const live = pod(HOME);
    const m = buildPodSwitcherModel([revoked, live], podBaseUrlFor(HOME));
    const leaders = podOptions(m).filter((o) => o.isLeader);
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.fqdn).toBe(HOME);
  });

  it("honours an explicit leaderFqdn override", () => {
    const m = buildPodSwitcherModel([pod(HOME), pod(WORK)], podBaseUrlFor(HOME), WORK);
    expect(podOptions(m).find((o) => o.fqdn === WORK)!.isLeader).toBe(true);
    expect(podOptions(m).find((o) => o.fqdn === HOME)!.isLeader).toBe(false);
  });

  it("leaderFqdnOf derives the earliest-registered non-revoked fqdn (lower-cased)", () => {
    expect(leaderFqdnOf([pod(HOME), pod(WORK)])).toBe(HOME.toLowerCase());
    expect(leaderFqdnOf([pod(WORK, { revokedAt: 1 }), pod(HOME)])).toBe(HOME.toLowerCase());
    expect(leaderFqdnOf([])).toBe("");
  });

  it("leaderFqdnOf skips a never-online pod (parity with iOS/Android leader suppression)", () => {
    // HOME registered first but has never come online (still provisioning);
    // WORK registered later but is live. The leader is the live pod, not the
    // earliest-registered one — a provisioning box must not wear the leader flag.
    const home = pod(HOME, { lastReported: null }); // registeredAt = N, never online
    const work = pod(WORK); // registeredAt = N+1, online (factory sets lastReported)
    expect(leaderFqdnOf([home, work])).toBe(WORK.toLowerCase());
    // A pod that came online via a landed cert (no heartbeat yet) still counts.
    const homeCert = pod(HOME, { lastReported: null, currentCert: { validUntil: Date.now() + 1e6 } });
    const workNever = pod(WORK, { lastReported: null });
    expect(leaderFqdnOf([homeCert, workNever])).toBe(HOME.toLowerCase());
    // No pod has come online yet ⇒ no leader flag anywhere.
    expect(leaderFqdnOf([pod(HOME, { lastReported: null }), pod(WORK, { lastReported: null })])).toBe("");
  });
});

describe("podSwitcher — selection marks the current pod", () => {
  it("marks exactly the pod matching the active base URL", () => {
    const m = buildPodSwitcherModel([pod(HOME), pod(WORK), pod(NAS)], podBaseUrlFor(WORK));
    const selected = m.options.filter((o) => o.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.fqdn).toBe(WORK);
    expect(m.selectedBaseUrl).toBe(podBaseUrlFor(WORK));
  });

  it("matches regardless of a trailing slash / scheme casing on the active URL", () => {
    const m = buildPodSwitcherModel(
      [pod(HOME), pod(WORK)],
      `https://${WORK}/`,
    );
    expect(m.options.find((o) => o.selected)!.fqdn).toBe(WORK);
  });

  it("falls back to 'All servers' when the active URL matches no pod", () => {
    // Paired to a box not in the directory (or no active URL yet): the
    // current scope is "All servers" (no single-pod emphasis).
    const m = buildPodSwitcherModel(
      [pod(HOME), pod(WORK)],
      "https://other.bob.flagship.services",
    );
    const selected = m.options.filter((o) => o.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.isAll).toBe(true);
    expect(m.selectedBaseUrl).toBe("");
  });

  it("emits a stable, name-sorted pod order with a usable base URL each", () => {
    const m = buildPodSwitcherModel([pod(WORK), pod(NAS), pod(HOME)], podBaseUrlFor(HOME));
    // "All servers" first, then name-sorted pods.
    expect(m.options.map((o) => o.name)).toEqual(["All servers", "home", "nas", "work"]);
    for (const o of podOptions(m)) {
      expect(o.baseUrl).toBe(`https://${o.fqdn}`);
      expect(o.podId).toBe(`pod-${o.fqdn.toLowerCase()}`);
    }
  });
});

describe("podSwitcher — switching updates the active selection", () => {
  it("re-deriving the model with the chosen pod's base URL moves the checkmark", () => {
    const pods = [pod(HOME), pod(WORK)];
    // Initially on HOME.
    const before = buildPodSwitcherModel(pods, podBaseUrlFor(HOME));
    expect(before.options.find((o) => o.selected)!.fqdn).toBe(HOME);

    // The view does: setPodBaseUrl(chosen) then re-render. Simulate by
    // re-building with the chosen pod's base URL — selection follows.
    const chosen = before.options.find((o) => o.fqdn === WORK)!.baseUrl;
    const after = buildPodSwitcherModel(pods, chosen);
    expect(after.options.find((o) => o.selected)!.fqdn).toBe(WORK);
    expect(after.selectedBaseUrl).toBe(podBaseUrlFor(WORK));
    // And the previously-selected pod is no longer selected.
    expect(after.options.find((o) => o.fqdn === HOME)!.selected).toBe(false);
  });

  it("selecting 'All servers' (empty base URL) clears single-pod scope", () => {
    const pods = [pod(HOME), pod(WORK)];
    // Switch to "All servers" by clearing the base URL.
    const after = buildPodSwitcherModel(pods, "");
    expect(after.all.selected).toBe(true);
    expect(after.selectedBaseUrl).toBe("");
    expect(podOptions(after).some((o) => o.selected)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildPodSwitcherModel,
  podBaseUrlFor,
  hostOfBaseUrl,
  podShortName,
} from "../public/webapp/lib/podSwitcher.js";

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
// fetchPodInventory — only `serverDomain` is load-bearing for the switcher.
function pod(serverDomain: string) {
  return { serverDomain, state: "online" as const };
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
    expect(m.options).toHaveLength(0);
  });

  it("is HIDDEN with exactly one pod", () => {
    const m = buildPodSwitcherModel([pod(HOME)], podBaseUrlFor(HOME));
    expect(m.show).toBe(false);
    // The single pod is still the (implicit) current selection.
    expect(m.options).toHaveLength(1);
    expect(m.options[0]!.selected).toBe(true);
  });

  it("is VISIBLE with two or more pods", () => {
    const m = buildPodSwitcherModel([pod(HOME), pod(WORK)], podBaseUrlFor(HOME));
    expect(m.show).toBe(true);
    expect(m.options).toHaveLength(2);
  });

  it("accepts a Map (statusByDomain) as well as an array", () => {
    const map = new Map([
      [HOME.toLowerCase(), pod(HOME)],
      [WORK.toLowerCase(), pod(WORK)],
    ]);
    const m = buildPodSwitcherModel(map, podBaseUrlFor(WORK));
    expect(m.show).toBe(true);
    expect(m.options.map((o) => o.fqdn).sort()).toEqual([HOME, WORK].sort());
  });

  it("ignores entries without a serverDomain (not a switch target)", () => {
    const m = buildPodSwitcherModel(
      [pod(HOME), { state: "pending" } as never, pod(WORK)],
      podBaseUrlFor(HOME),
    );
    expect(m.options).toHaveLength(2);
  });

  it("de-dupes on fqdn (case-insensitive)", () => {
    const m = buildPodSwitcherModel(
      [pod(HOME), pod(HOME.toUpperCase()), pod(WORK)],
      podBaseUrlFor(HOME),
    );
    expect(m.options).toHaveLength(2);
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

  it("defaults selection to the first pod when the active URL matches none", () => {
    // Paired to a box not in the directory (or no active URL yet): always
    // surface a current value, like iOS defaulting the current pod.
    const m = buildPodSwitcherModel(
      [pod(HOME), pod(WORK)],
      "https://other.bob.flagship.services",
    );
    const selected = m.options.filter((o) => o.selected);
    expect(selected).toHaveLength(1);
    // Options are name-sorted; "home" sorts before "work".
    expect(selected[0]!.fqdn).toBe(HOME);
    expect(m.selectedBaseUrl).toBe(podBaseUrlFor(HOME));
  });

  it("emits a stable, name-sorted option order with a usable base URL each", () => {
    const m = buildPodSwitcherModel([pod(WORK), pod(NAS), pod(HOME)], podBaseUrlFor(HOME));
    expect(m.options.map((o) => o.name)).toEqual(["home", "nas", "work"]);
    for (const o of m.options) {
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
});

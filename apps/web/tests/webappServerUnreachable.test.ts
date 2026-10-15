// A server's page when the box doesn't answer: the honest state from what
// `.com` knows, as iOS ServerDetailScreen shows it (revoked / offline / still
// coming up / never came online / not paired here + "Pair this server" /
// connecting), with the Danger zone still there.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain-JS webapp module, no types
import { renderUnreachableDetail, unreachableKind } from "../public/webapp/views/server-detail.js";

const VIEW = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "server-detail.js"), "utf8");
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const fqdn = "home.plucky-avocet.flagship.services";

describe("why the box's page didn't load", () => {
  it("revoked wins over everything", () => {
    expect(unreachableKind({ revoked: true, pod: { liveness: "live" }, now: NOW })).toBe("revoked");
  });

  it("offline: checked in before, not now", () => {
    expect(unreachableKind({ pod: { liveness: "unreachable" }, now: NOW })).toBe("offline");
    expect(unreachableKind({ pod: { lastReported: NOW - 30 * MIN }, now: NOW })).toBe("offline");
  });

  it("still coming up inside the first 20 minutes, or while it waits for an approval", () => {
    expect(unreachableKind({ pod: { liveness: "never", registeredAt: NOW - 5 * MIN }, now: NOW })).toBe("coming-up");
    expect(unreachableKind({ pod: { liveness: "never", registeredAt: NOW - 90 * MIN, pendingRequests: [{ type: "unlock" }] }, now: NOW })).toBe("coming-up");
  });

  it("never came online after that", () => {
    expect(unreachableKind({ pod: { liveness: "never", registeredAt: NOW - 90 * MIN }, now: NOW })).toBe("never-online");
    expect(unreachableKind({ pod: { registeredAt: NOW - 90 * MIN }, now: NOW })).toBe("never-online");
  });

  it("not paired: online, but this browser has no session for it (status 0)", () => {
    expect(unreachableKind({ pod: { liveness: "live" }, error: { status: 0 }, now: NOW })).toBe("not-paired");
  });

  it("connecting: online, the daemon just didn't answer", () => {
    expect(unreachableKind({ pod: { liveness: "live" }, error: { status: 502 }, now: NOW })).toBe("connecting");
    expect(unreachableKind({ pod: null, error: { status: 502 }, now: NOW })).toBe("connecting");
  });
});

describe("the page for each state", () => {
  const page = (kind: string, extra: Record<string, unknown> = {}) =>
    renderUnreachableDetail({ serverFqdn: fqdn, username: "plucky-avocet", revoked: kind === "revoked", kind, now: NOW, ...extra });

  it("uses iOS's ids and keeps the Danger zone on every one", () => {
    for (const [kind, id] of [
      ["revoked", "server-detail-revoked"],
      ["offline", "server-detail-offline"],
      ["coming-up", "server-detail-coming-up"],
      ["never-online", "server-detail-never-online"],
      ["not-paired", "server-detail-not-paired"],
      ["connecting", "server-detail-connecting"],
    ]) {
      const html: string = page(kind!);
      expect(html, kind).toContain(`id="${id}"`);
      expect(html, kind).toContain('id="delete-server-btn"');
      expect(html, kind).toContain(fqdn);
    }
  });

  it("says when an offline box was last seen", () => {
    expect(page("offline", { pod: { lastReported: NOW - 3 * 60 * MIN } })).toContain("Offline — last seen 3 h ago");
  });

  it("only the not-paired card offers Pair this server", () => {
    expect(page("not-paired")).toContain('id="sd-pair-server"');
    for (const kind of ["offline", "coming-up", "never-online", "connecting", "revoked"]) {
      expect(page(kind)).not.toContain('id="sd-pair-server"');
    }
  });

  it("keeps the revoked line the web gym reads", () => {
    expect(page("revoked")).toContain(
      "<p class=\"note mt-2\" data-detail-unreachable>This server is revoked. It can't connect or unlock until you un-revoke it.</p>",
    );
  });

  it("never calls an unanswered page 'not paired'", () => {
    expect(page("connecting", { message: "HTTP 502" })).not.toMatch(/isn.t paired/);
    expect(page("connecting", { message: "HTTP 502" })).toContain("HTTP 502");
  });

  it("Pair this server signs the same add-paired-session order auto-pair does, then reloads", () => {
    const fn = VIEW.slice(VIEW.indexOf("function wirePairServer"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain('import("../lib/autoPair.js")');
    expect(body).toContain("autoPairPods([");
    expect(body).toContain("await renderServerDetail();");
  });
});

// SEC-BROWSER-002 and N12 on the webapp: the owner's answer to an app's browser-access request
// (signed `flagship/browser-grant/v1` for exactly what was shown, the ask's own duration; a denial
// unsigned), the wording built from the structured ask, and the upstream-sync proposal (capability
// changes apart from the code). Signatures pinned by packages/protocol/test-vectors/browser-grant.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ed } from "@flagship/protocol";

vi.mock("../public/webapp/lib/toast.js", () => ({ toast: vi.fn() }));

import {
  allowLabel,
  appNamesOf,
  browserAccessSectionHtml,
  browserGrantAnswerBody,
  browserGrantError,
  capabilityLabel,
  durationLine,
  fetchBrowserGrantsOnServers,
  grantDetailsHtml,
  grantRequestTitle,
  localNetworkLine,
  manifestBrowserDomains,
  readGrantRequests,
  // @ts-expect-error plain browser module
} from "../public/webapp/lib/browserGrantAlerts.js";
import {
  conflictsHeading,
  proposalHtml,
  readSyncResult,
  repoLabel,
  requestSync,
  sectionLabel,
  summaryLines,
  syncRepoOf,
  SYNC_COPY,
  upToDateText,
  // @ts-expect-error plain browser module
} from "../public/webapp/lib/upstreamSync.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/browser-grant/vectors.json"), "utf8"));
const seed = Buffer.from(v.seedHex, "hex");
const sign = async (b: Uint8Array) => ed.sign(b, seed);

const ask = {
  requestId: "7c1e2a90-1b3d-4f5e-8a6b-0c9d8e7f6a5b",
  serviceId: "alice--shop",
  capabilities: ["read-dom", "navigate"],
  origins: ["*.example.com", "shop.example.org"],
  localNetwork: { kind: "exact", hosts: ["printer.local"] },
  duration: "session",
  explanation: "To print <your> receipts",
  at: 1,
  meaning: ["Can navigate on: ... (the box's English, never shown)"],
};

describe("browser access requests", () => {
  it("keeps well-formed asks only and never the box's English description", () => {
    const list = readGrantRequests({ requests: [ask, { ...ask, requestId: "", serviceId: "x" }, { ...ask, duration: "forever" }, { ...ask, capabilities: ["teleport"] }, { ...ask, origins: [], localNetwork: null }] });
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("meaning");
    const html = grantDetailsHtml(list[0]);
    expect(html).not.toContain("the box's English");
    expect(html).toContain("*.example.com");
    expect(html).toContain("and every address under it");
    expect(html).toContain("These devices on your network: printer.local");
    expect(html).toContain("Read page content");
    expect(html).toContain("Until this browser session ends");
    expect(html).toContain("The app says:");
    expect(html).toContain("&lt;your&gt;");
  });

  it("says each part in the shared words", () => {
    expect(grantRequestTitle({ ...ask, appName: "shop" })).toBe("shop wants to use this server's browser.");
    expect(["navigate", "read-dom", "screenshot", "input", "download"].map(capabilityLabel)).toEqual(["Open pages", "Read page content", "Take screenshots", "Type and click", "Download files"]);
    expect(["once", "session", "service"].map(durationLine)).toEqual(["For one visit", "Until this browser session ends", "Until you remove it"]);
    expect(["once", "session", "service"].map(allowLabel)).toEqual(["Allow once", "Allow for this session", "Always allow"]);
    expect(localNetworkLine({ kind: "whole-lan" })).toBe("Every device on your local network");
    expect(browserGrantError({ status: 403 })).toBe("This device can't approve browser access. Use an admin device.");
    expect(browserGrantError({ status: 404 })).toBe("That request is no longer waiting.");
  });

  it("an Allow signs the shared vector's bytes; the duration is the ask's", async () => {
    for (const { answer, signatureHex } of v.answers.filter((a: { answer: { decision: string } }) => a.answer.decision === "allow")) {
      const r = { ...answer };
      const body = await browserGrantAnswerBody(r, "allow", { serverDomain: answer.serverDomain, sign, now: () => answer.issuedAt });
      expect(body).toEqual({ requestId: answer.requestId, decision: "allow", issuedAt: answer.issuedAt, signature: signatureHex });
    }
  });

  it("a Deny carries no signature", async () => {
    const s = vi.fn();
    const body = await browserGrantAnswerBody(ask, "deny", { serverDomain: "home.alice.flagship.services", sign: s, now: () => 5 });
    expect(body).toEqual({ requestId: ask.requestId, decision: "deny", issuedAt: 5 });
    expect(s).not.toHaveBeenCalled();
  });

  it("collects asks from every server with the app's own name; a 404 adds nothing", async () => {
    const servers = [
      { fqdn: "home.alice.flagship.services", fetchJson: async (p: string) => (p.includes("grant-requests") ? { requests: [ask] } : { apps: [{ serviceId: "alice--shop", slug: "shop" }] }) },
      { fqdn: "office.alice.flagship.services", fetchJson: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } },
    ];
    const all = await fetchBrowserGrantsOnServers(servers);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ serverDomain: "home.alice.flagship.services", appName: "shop" });
    expect(appNamesOf({ apps: [{ serviceId: "a--b" }] })).toEqual({ "a--b": "a--b" });
  });

  it("the app page lists what the manifest grants, then the waiting asks", () => {
    expect(manifestBrowserDomains({ browser: { domains: ["example.com", 3] } })).toEqual(["example.com"]);
    const html = browserAccessSectionHtml({ domains: ["example.com"], requests: readGrantRequests({ requests: [ask] }), canAnswer: true });
    expect(html).toContain("Browser access");
    expect(html).toContain("Approved when you installed it");
    expect(html).toContain('data-browser-answer="allow"');
    expect(html).toContain("Allow for this session");
    expect(browserAccessSectionHtml({ domains: [], requests: readGrantRequests({ requests: [ask] }), canAnswer: false })).toContain("Use an admin device.");
    expect(browserAccessSectionHtml({})).toBe("");
  });
});

const PROPOSAL = {
  ok: true,
  buildId: "0123456789abcdef",
  candidateCommit: "9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc",
  upToDate: false,
  proposal: {
    upstreamChanged: ["src/a.ts", "src/b.ts", "flagship.app.json"],
    localChanged: ["src/b.ts", "README.md"],
    takeUpstream: ["src/a.ts", "flagship.app.json"],
    conflicts: ["src/b.ts"],
    alreadyApplied: [],
    capabilityChanges: [{ section: "network.egress", added: ["api.example.com"], removed: [] }, { section: "x.custom", added: [], removed: ["y"] }],
    clean: false,
  },
};

describe("upstream sync", () => {
  it("names the repo from the import record, else the adapter", () => {
    expect(syncRepoOf({ importedFrom: { repo: "https://github.com/a/b.git" }, adaptedFrom: { repo: "x" } })).toBe("https://github.com/a/b.git");
    expect(syncRepoOf({ adaptedFrom: { repo: "github.com/c/d" } })).toBe("github.com/c/d");
    expect(syncRepoOf({ editable: true })).toBe("");
    expect(repoLabel("https://github.com/a/b.git")).toBe("github.com/a/b");
    expect(upToDateText("https://github.com/a/b")).toBe("You already run the latest version from github.com/a/b.");
  });

  it("shows capability changes apart and first, then the counts and the conflicts", () => {
    const r = readSyncResult(PROPOSAL)!;
    expect(summaryLines(r)).toEqual(["2 files updated from upstream", "1 of your changes kept"]);
    expect(conflictsHeading(1)).toBe("1 conflict: your version was kept");
    const html = proposalHtml("https://github.com/a/b", r);
    expect(html).toContain("Update from github.com/a/b");
    expect(html).toContain("Version 9f8e7d6c5b4a");
    expect(html.indexOf("New permissions")).toBeLessThan(html.indexOf("files updated from upstream"));
    expect(html).toContain("Internet access");
    expect(html).toContain("Adds: api.example.com");
    expect(html).toContain("Removes: y");
    expect(sectionLabel("x.custom")).toBe("x.custom");
    expect(html).toContain("src/b.ts");
    expect(html).toContain(SYNC_COPY.conflictsNote);
    expect(html).toContain("Nothing goes live until you deploy.");
  });

  it("sends the chosen ref and says plainly when the app was not imported", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = { fqdn: "home", fetch: async (path: string, init: { body: string }) => (calls.push({ path, body: JSON.parse(init.body) }), PROPOSAL) };
    const r = await requestSync(client, "alice--blog", "v2.0");
    expect(calls[0]).toEqual({ path: "/api/build/apps/alice--blog/sync", body: { ref: "v2.0" } });
    expect(r.buildId).toBe(PROPOSAL.buildId);
    const missing = { fqdn: "home", fetch: async () => { throw Object.assign(new Error("x"), { status: 404, body: { error: "this app was not imported" } }); } };
    await expect(requestSync(missing, "alice--blog", "")).rejects.toThrow("This app wasn't imported from a repo on this server, so it can't check for updates.");
    const other = { fqdn: "home", fetch: async () => { throw Object.assign(new Error("x"), { status: 422, body: { error: "the repo could not be read" } }); } };
    await expect(requestSync(other, "alice--blog", "")).rejects.toThrow("the repo could not be read");
  });
});

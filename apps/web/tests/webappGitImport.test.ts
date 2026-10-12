// Git import (webapp parity of the iOS change): an optional name checked as
// you type, the box's reasons for a refused repo, an AI adapt followed in the
// background, and open git builds in Build sessions with Discard.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError, boxReason } from "../public/webapp/lib/api.js";

async function load(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href);
}
const loadGit = () => load("lib/gitImport.js");
const loadSessions = () => load("lib/vibeSessions.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const instant = { sleep: async () => {}, intervalMs: 1 };

describe("git import helpers", () => {
  it("sends the typed name as a label, and nothing when it's blank", async () => {
    const { gitRequestBody, addressLabel } = await loadGit();
    expect(gitRequestBody({ gitUrl: " https://github.com/me/random ", ref: "", name: "My App" })).toEqual({
      gitUrl: "https://github.com/me/random",
      name: "myapp",
    });
    expect(gitRequestBody({ gitUrl: "https://github.com/me/random", ref: " dev ", name: "  " })).toEqual({
      gitUrl: "https://github.com/me/random",
      ref: "dev",
    });
    expect(addressLabel("myapp", "random-dev")).toBe("myapp");
    expect(addressLabel("", "random-dev")).toBe("random-dev");
    expect(addressLabel("", null)).toBe("<repo name>");
  });

  it("says a blank name is taken from the repo, and the branch once one is typed", async () => {
    const { blankNameHint } = await loadGit();
    expect(blankNameHint("")).toBe("Leave it blank to name it after the repo.");
    expect(blankNameHint("dev")).toBe("Leave it blank to name it after the repo and branch.");
  });

  it("reads a taken name as the conflict the describe form shows", async () => {
    const { checkRepoFailure } = await loadGit();
    const body = { error: 'A build session already uses the name "notes".', ok: false, kind: "session", sessionId: "s1", message: "x" };
    const got = checkRepoFailure(new ScreensError(body.error, 409, body));
    expect(got.conflict.kind).toBe("session");
    expect(got.conflict.sessionId).toBe("s1");
  });

  it("shows the box's reason for a repo it can't clone or a name it won't take", async () => {
    const { checkRepoFailure } = await loadGit();
    const reason = "Couldn't clone this repo. Check the address, and that the repo is public.";
    expect(checkRepoFailure(new ScreensError(reason, 422, { error: reason }))).toEqual({ message: reason });
    expect(checkRepoFailure(new ScreensError("bad", 400, { error: "Use lowercase letters." }))).toEqual({
      message: "Use lowercase letters.",
    });
    expect(checkRepoFailure(new ScreensError("not found", 404, { error: "not found" })).message).toMatch(
      /isn't set up to build services yet/,
    );
  });

  it("reads the box's own explanation only from a JSON error body", () => {
    expect(boxReason(new ScreensError("x", 502, { error: "adapt model call failed: bad key" }))).toBe(
      "adapt model call failed: bad key",
    );
    expect(boxReason(new ScreensError("HTTP 502", 502, "<html>"))).toBeNull();
    expect(boxReason(new ScreensError("x", 0))).toBeNull();
    expect(boxReason(new Error("x"))).toBeNull();
  });

  it("an adapt the AI deployed itself lands on Installed", async () => {
    const { followAdapt } = await loadGit();
    const states = [
      { state: { buildId: "b", mode: "git", adapt: { status: "running" } } },
      { state: { buildId: "b", mode: "git", adapt: { status: "done", fileCount: 8, deployed: true, deployedUrl: "https://hello.home.me.flagship.services" } } },
    ];
    const progress: string[] = [];
    const out = await followAdapt({
      ...instant,
      fetchState: async () => states.shift(),
      fetchJournal: async () => ({ entries: [{ summary: "reading the repo" }, { summary: "writing flagship.app.json" }] }),
      onProgress: (p: string) => progress.push(p),
    });
    expect(out).toEqual({ phase: "installed", url: "https://hello.home.me.flagship.services" });
    expect(progress).toEqual(["writing flagship.app.json"]);
  });

  it("an adapt that didn't deploy is ready to install", async () => {
    const { followAdapt, adaptFinished } = await loadGit();
    const out = await followAdapt({
      ...instant,
      fetchState: async () => ({ state: { adapt: { status: "done", fileCount: 16, deployed: false } } }),
      fetchJournal: async () => ({ entries: [] }),
    });
    expect(out).toEqual({ phase: "adapted", fileCount: 16 });
    // An older box answers the adapt itself, with the finished result.
    expect(adaptFinished({ ok: true, fileCount: 5 })).toEqual({ phase: "adapted", fileCount: 5 });
    expect(adaptFinished({ ok: true, fileCount: 5, deployed: true, deployedUrl: "https://x" })).toEqual({
      phase: "installed",
      url: "https://x",
    });
  });

  it("a failed adapt reports the box's reason", async () => {
    const { followAdapt } = await loadGit();
    const out = await followAdapt({
      ...instant,
      fetchState: async () => ({ state: { adapt: { status: "failed", reason: "adapt model call failed: bad key" } } }),
      fetchJournal: async () => ({ entries: [] }),
    });
    expect(out).toEqual({ phase: "failed", reason: "adapt model call failed: bad key" });
  });

  it("rides out a few dropped polls, then gives up", async () => {
    const { followAdapt } = await loadGit();
    let n = 0;
    const out = await followAdapt({
      ...instant,
      fetchState: async () => {
        n += 1;
        if (n <= 4) throw new Error("offline");
        return { state: { adapt: { status: "done", fileCount: 1, deployed: false } } };
      },
      fetchJournal: async () => ({ entries: [] }),
    });
    expect(out.phase).toBe("adapted");
    await expect(
      followAdapt({ ...instant, fetchState: async () => { throw new Error("offline"); }, fetchJournal: async () => ({}) }),
    ).rejects.toThrow("offline");
  });

  it("stops following after its time limit", async () => {
    const { followAdapt, ADAPT_TOO_LONG } = await loadGit();
    let t = 0;
    const out = await followAdapt({
      intervalMs: 1000,
      limitMs: 3000,
      sleep: async (ms: number) => { t += ms; },
      now: () => t,
      fetchState: async () => ({ state: { adapt: { status: "running" } } }),
      fetchJournal: async () => ({ entries: [] }),
    });
    expect(out).toEqual({ phase: "failed", reason: ADAPT_TOO_LONG });
  });

  it("the not-ready card says it plainly", async () => {
    const { notReadyText } = await loadGit();
    expect(notReadyText("no flagship.app.json — repo isn't a Flagship app yet; the AI can adapt it")).toBe(
      "This repo is not yet adapted for Flagship.",
    );
    expect(notReadyText("flagship.app.json present but invalid: name")).toBe("flagship.app.json present but invalid: name");
  });
});

describe("Get flagship.app.json", () => {
  function fakeDom() {
    const links: Array<{ href: string; download: string; clicked: boolean; removed: boolean }> = [];
    const revoked: string[] = [];
    const doc = {
      createElement: () => {
        const a = { href: "", download: "", clicked: false, removed: false, click() { a.clicked = true; }, remove() { a.removed = true; } };
        links.push(a);
        return a;
      },
      body: { appendChild: () => {} },
    };
    const urls = { createObjectURL: () => "blob:adapter", revokeObjectURL: (u: string) => revoked.push(u) };
    return { doc, urls, links, revoked, later: (fn: () => void) => fn() };
  }

  it("fetches the build's file and downloads it as flagship.app.json", async () => {
    const { exportAdapter, downloadAdapterFile } = await loadGit();
    const dom = fakeDom();
    const fetchJson = vi.fn(async () => ({ file: '{"schema_version": 1, "name": "imported-app", "adapter": {"version": 1}}' }));
    let blob: Blob | null = null;
    const r = await exportAdapter({
      buildId: "bld 1",
      fetchJson,
      save: (text: string) => { blob = downloadAdapterFile(text, dom); },
    });
    expect(r).toEqual({ ok: true });
    expect(fetchJson).toHaveBeenCalledWith("/api/build/sessions/bld%201/adapter");
    expect(dom.links).toHaveLength(1);
    expect(dom.links[0]!.download).toBe("flagship.app.json");
    expect(dom.links[0]!.clicked).toBe(true);
    expect(dom.links[0]!.removed).toBe(true);
    expect(dom.revoked).toEqual(["blob:adapter"]);
    expect(await blob!.text()).toContain('"adapter"');
  });

  it("shows the box's reason when there's no file, else the usual message", async () => {
    const { exportAdapter } = await loadGit();
    const save = vi.fn();
    const missing = await exportAdapter({
      buildId: "b",
      fetchJson: async () => {
        throw new ScreensError("HTTP 404", 404, { error: "no flagship.app.json for this build" });
      },
      save,
    });
    expect(missing).toEqual({ ok: false, message: "no flagship.app.json for this build" });
    const offline = await exportAdapter({
      buildId: "b",
      fetchJson: async () => {
        throw new ScreensError("not paired to a server yet", 0);
      },
      save,
    });
    expect(offline).toEqual({ ok: false, message: "not paired to a server yet" });
    expect(save).not.toHaveBeenCalled();
  });

  it("is offered on the Adapted and Installed cards with what to do with it", async () => {
    const js = await asset("/webapp/views/build-git.js");
    const adapted = js.slice(js.indexOf("function renderAdapted"), js.indexOf("function renderInstalled"));
    const installed = js.slice(js.indexOf("function renderInstalled"), js.indexOf("function adapterExport"));
    for (const card of [adapted, installed]) {
      expect(card).toContain("${adapterExport()}");
      expect(card).toContain("wireAdapterExport();");
    }
    expect(js).toContain('id="build-git-export" class="secondary full-width mt-2"');
    expect(js).toContain("btn.textContent = EXPORT_PREPARING;");
    expect(js).toContain('toast(r.message, "err")');
    const { EXPORT_BUTTON, EXPORT_PREPARING, EXPORT_NOTE } = await loadGit();
    expect(EXPORT_BUTTON).toBe("Get flagship.app.json");
    expect(EXPORT_PREPARING).toBe("Preparing…");
    expect(EXPORT_NOTE).toBe("Is this your repo? Commit this file at its root and every Flagship server will run it this way.");
  });
});

describe("open git and IDE builds in Build sessions", () => {
  it("are listed apart from past builds and can be discarded", async () => {
    const { openBuilds, endedBuilds, discardBuild, discardBuildMessage } = await loadSessions();
    const builds = [
      { buildId: "g1", mode: "git", name: "notes", startedAt: 1, entryCount: 3, open: true },
      { buildId: "g0", mode: "git", name: "old", startedAt: 1, entryCount: 5 },
      { buildId: "s1", mode: "scratch", name: "chat", startedAt: 1, entryCount: 2, open: true },
    ];
    const sessions = [{ sessionId: "s1" }];
    expect(openBuilds(builds, sessions).map((b: { buildId: string }) => b.buildId)).toEqual(["g1"]);
    expect(endedBuilds(builds, sessions).map((b: { buildId: string }) => b.buildId)).toEqual(["g0"]);
    expect(discardBuildMessage(builds[0])).toBe(
      'This deletes what was imported or written on your server. Its name, "notes", becomes free again.',
    );

    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await discardBuild({ baseUrl: "https://home.alice.flagship.services/", token: "tok", buildId: "g1", fetchImpl: ok });
    expect(ok).toHaveBeenCalledWith("https://home.alice.flagship.services/api/build/sessions/g1/discard", {
      method: "POST",
      headers: { "x-flagship-session": "tok", "content-type": "application/json" },
      body: "{}",
    });
    await expect(
      discardBuild({
        baseUrl: "https://b",
        token: "t",
        buildId: "g1",
        fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: "the AI is still working on this build" }) }),
      }),
    ).rejects.toThrow("the AI is still working on this build");
  });

  it("the list shows them under Open on your server with Discard", async () => {
    const js = await asset("/webapp/views/build-journal.js");
    expect(js).toContain("openBuilds(builds, sessions)");
    expect(js).toContain("data-discard-build");
    expect(js).toContain("discardBuildMessage(build)");
  });
});

describe("git import screen", () => {
  it("has no in-page subtitle and takes an optional name with its address", async () => {
    const html = await asset("/webapp/index.html");
    const section = html.slice(html.indexOf('id="view-build-git"'), html.indexOf('id="view-build-mcp"'));
    expect(section).toContain("<h2>Git import</h2>");
    expect(section).not.toContain("checked for a <code>flagship.app.json</code>");
    expect(section).toContain("Repository URL");
    expect(section).toContain("Branch or tag (optional)");
    expect(section).toContain("Name (optional)");
    expect(section).toContain('placeholder="From the repo\'s name"');
    expect(section).toContain('id="build-git-address"');
    expect(section).toContain('id="build-git-name-status"');
  });

  it("checks the name as you type and refuses Check repo on a taken one", async () => {
    const js = await asset("/webapp/views/build-git.js");
    expect(js).toContain("checkName(");
    expect(js).toMatch(/setTimeout\(\(\) => void runNameCheck\(slug\), 350\)/);
    expect(js).toContain("currentCheck()?.ok === false");
    expect(js).toContain("showConflict(failure.conflict");
    expect(js).toContain("adaptRequestBody(");
  });
});

describe("share the adaptation, and a shared adaptation that crashes", () => {
  it("the check no longer carries the share choice; the adapt does", async () => {
    const { gitRequestBody, adaptRequestBody } = await loadGit();
    expect(gitRequestBody({ gitUrl: "https://github.com/me/random", ref: "", name: "" })).toEqual({
      gitUrl: "https://github.com/me/random",
    });
    expect(adaptRequestBody({ credential: null })).toEqual({ background: true, share: true });
    expect(adaptRequestBody({ credential: { kind: "saved" }, share: false })).toEqual({
      credential: { kind: "saved" },
      background: true,
      share: false,
    });
  });

  it("the switch lives on the not-ready card, on by default, which replaces Check repo", async () => {
    const { SHARE_LABEL, SHARE_NOTE, CHECK_AGAIN } = await loadGit();
    expect(SHARE_LABEL).toBe("Anonymously share your adaptation");
    expect(SHARE_NOTE).toBe("Others can then install this repo without AI. Nothing about you or your server is included.");
    expect(CHECK_AGAIN).toBe("Check again");
    const html = await asset("/webapp/index.html");
    const section = html.slice(html.indexOf('id="view-build-git"'), html.indexOf('id="view-build-mcp"'));
    expect(section).not.toContain("build-git-share");
    const js = await asset("/webapp/views/build-git.js");
    expect(js).toContain('id="build-git-share" role="switch"${share ? " checked" : ""}');
    expect(js).toContain("adaptRequestBody({ credential: adaptCredential, share })");
    expect(js).toContain('btn.classList.toggle("hidden", verdictShown)');
    expect(js).toContain('$("build-git-recheck").addEventListener("click", checkRepo)');
  });

  it("a failed Install that needs the AI shows the not-ready card with the box's reason", async () => {
    const { deployFailure, notReadyText } = await loadGit();
    const reason =
      "docker build failed: exit 1. The shared adaptation of this repo didn't work on this server, so it has been reported. Use AI to prepare the repo for Flagship instead.";
    const got = deployFailure(new ScreensError(reason, 502, { error: reason, needsAdapt: true }));
    expect(got).toEqual({ needsAdapt: true, reason });
    expect(notReadyText(got.reason)).toContain("didn't work on this server");
    expect(deployFailure(new ScreensError("x", 502, { error: "docker build failed: exit 1" }))).toEqual({
      message: "docker build failed: exit 1",
    });
    const js = await asset("/webapp/views/build-git.js");
    const deploy = js.slice(js.indexOf("async function deploy()"));
    expect(deploy).toContain("if (failure.needsAdapt) {");
    expect(deploy).toContain("renderVerdict({ buildId, fit: false, reason: failure.reason");
  });

  it("an adapt the box already started (409) is followed to Adapted", async () => {
    const { startAndFollowAdapt, followAdapt } = await loadGit();
    const start = vi.fn(async () => {
      throw new ScreensError("HTTP 409", 409, { error: "the AI is already adapting this repo" });
    });
    const out = await startAndFollowAdapt({
      start,
      follow: () =>
        followAdapt({
          ...instant,
          fetchState: async () => ({ state: { adapt: { status: "done", fileCount: 16, deployed: false } } }),
          fetchJournal: async () => ({ entries: [] }),
        }),
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ phase: "adapted", fileCount: 16 });
  });

  it("a started adapt is followed, an older box's answer is used, other refusals are thrown", async () => {
    const { startAndFollowAdapt } = await loadGit();
    const follow = vi.fn(async () => ({ phase: "adapted", fileCount: 3 }));
    expect(await startAndFollowAdapt({ start: async () => ({ ok: true, started: true }), follow })).toEqual({
      phase: "adapted",
      fileCount: 3,
    });
    expect(await startAndFollowAdapt({ start: async () => ({ ok: true, fileCount: 7 }), follow })).toEqual({
      phase: "adapted",
      fileCount: 7,
    });
    expect(follow).toHaveBeenCalledTimes(1);
    await expect(
      startAndFollowAdapt({
        start: async () => {
          throw new ScreensError("AI adapt not configured", 503, { error: "AI adapt not configured" });
        },
        follow,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(follow).toHaveBeenCalledTimes(1);
  });
});

// "Edit this service" (webapp parity of the iOS change): the service page
// offers changing it with the AI chat or from an IDE, and the box's refusals
// get their own prompts.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function load(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href);
}
const loadEdit = () => load("lib/editService.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

class FakeScreensError extends Error {
  constructor(message: string, public status: number, public body: unknown = null) {
    super(message);
  }
}

describe("edit-service helpers", () => {
  it("names the service by the slug half of its id", async () => {
    const { serviceSlug, editTitle } = await loadEdit();
    expect(serviceSlug("alice--notes")).toBe("notes");
    expect(serviceSlug("alice--my-notes")).toBe("my-notes");
    expect(serviceSlug("notes")).toBe("notes");
    expect(editTitle("notes")).toBe("Edit notes");
  });

  it("reads the box's refusals into the right prompt", async () => {
    const { editRefusal, refusalTitle, refusalMessage } = await loadEdit();
    const open = editRefusal(
      new FakeScreensError("x", 409, { ok: false, kind: "session", sessionId: "s1", name: "notes", error: "x" }),
    );
    expect(open).toEqual({ kind: "session" });
    expect(refusalTitle(open)).toBe("Already being changed");
    expect(refusalMessage(open, "notes")).toBe(
      "A build session is already changing notes. Open it from Build sessions, or discard it there to start over.",
    );

    const tooBigMsg = '"notes" is too big to change in the AI chat. Connect your IDE to change it instead.';
    const big = editRefusal(new FakeScreensError(tooBigMsg, 413, { error: tooBigMsg }));
    expect(big).toEqual({ kind: "tooBig", message: tooBigMsg });
    expect(refusalTitle(big)).toBe("Too big for the AI chat");
    expect(refusalMessage(big, "notes")).toBe(tooBigMsg);
    expect(editRefusal(new FakeScreensError("HTTP 413", 413, "")).kind).toBe("tooBig");

    const gone = editRefusal(new FakeScreensError("That service isn't installed.", 404, { error: "That service isn't installed." }));
    expect(gone).toEqual({ kind: "other", message: "That service isn't installed." });
    expect(refusalTitle(gone)).toBe("Couldn't start");

    // A 409 for something other than an open session isn't read as one.
    expect(editRefusal(new FakeScreensError("x", 409, { error: "nope" }))).toEqual({ kind: "other", message: "nope" });
    // No body: still a plain-language message, never empty.
    expect(editRefusal(new Error("boom")).message).toBeTruthy();
  });

  it("Start needs something to change and isn't tappable twice", async () => {
    const { canStart } = await loadEdit();
    expect(canStart("", false)).toBe(false);
    expect(canStart("   \n", false)).toBe(false);
    expect(canStart("Add a due date", true)).toBe(false);
    expect(canStart("Add a due date", false)).toBe(true);
  });

  it("the IDE intro says what editing changes", async () => {
    const { ideEditIntro } = await loadEdit();
    expect(ideEditIntro("notes")).toBe(
      "Your editor's agent changes notes on your server, starting from its current code, using your own AI subscription. Deploying from the IDE replaces the running version; its address and data stay the same.",
    );
  });
});

describe("edit-service screens", () => {
  it("service detail shows the edit row only when the box says it's editable", async () => {
    const js = await asset("/webapp/views/service-detail.js");
    expect(js).toContain('body.editable === true ? renderEditRow() : ""');
    expect(js).toContain('id="sd-edit"');
    expect(js).toContain("enterEditService(s.serviceId)");
    const lib = await asset("/webapp/lib/editService.js");
    expect(lib).toContain('"Edit this service"');
    expect(lib).toContain('"Change it with AI, or in your own editor"');
  });

  it("the chooser and the describe step carry the iOS copy", async () => {
    const lib = await asset("/webapp/lib/editService.js");
    expect(lib).toContain('title: "Describe the change"');
    expect(lib).toContain('"Tell the AI what to change. It starts from the current code."');
    expect(lib).toContain('title: "Use your IDE"');
    expect(lib).toContain('"Connect Cursor, Cline or another editor and change it with your own AI."');
    expect(lib).toContain(
      '"The new version replaces the one running now. Its address, data and the people who can open it stay the same."',
    );
    const html = await asset("/webapp/index.html");
    const describe = html.slice(html.indexOf('id="view-edit-describe"'), html.indexOf('id="edit-describe-back"'));
    expect(describe).toContain("What should change?");
    expect(describe).toMatch(/<textarea id="edit-describe-prompt"[^>]*><\/textarea>/);
    expect(describe).toContain('For example: "Add a due date to each item and sort by it."');
    expect(describe).toMatch(/id="edit-describe-start"[^>]*disabled>Start</);
    expect(html).toContain('id="view-edit-service"');
  });

  it("describing a change sends editServiceId and opens the session with Back to the service", async () => {
    const js = await asset("/webapp/views/edit-service.js");
    expect(js).toContain('registerView("view-edit-service")');
    expect(js).toContain('registerView("view-edit-describe")');
    expect(js).toContain("enterBuildKey");
    expect(js).toContain("{ prompt, editServiceId: id }");
    expect(js).toContain("/api/screens/vibe-code/start");
    expect(js).toContain("openVibeCodeSession(r.sessionId, { credential, back: () => openService(id) })");
    expect(js).toContain('"Starting…"');
    // The refusal pop-ups and where their buttons go.
    expect(js).toContain('okLabel: "Open build sessions", cancelLabel: "OK"');
    expect(js).toContain("enterBuildJournal()");
    expect(js).toContain('okLabel: "Use your IDE", cancelLabel: "OK"');
    expect(js).toContain("inlineAlert");

    const vibe = await asset("/webapp/views/vibe-code.js");
    expect(vibe).toContain("export async function openVibeCodeSession(sessionId, { back = null, credential = null, server = \"\" } = {})");
    expect(vibe).toContain("if (backTo) void backTo();");
  });

  it("the IDE route creates the build from the service's code", async () => {
    const js = await asset("/webapp/views/build-mcp.js");
    expect(js).toContain("if (editServiceId) body.editServiceId = editServiceId;");
    expect(js).toContain("ideEditIntro(serviceSlug(editId))");
    expect(js).toContain("show(backView)");
    const html = await asset("/webapp/index.html");
    expect(html).toContain('id="build-mcp-intro"');
  });

  it("app.js wires the views and the shell precaches them", async () => {
    const app = await asset("/webapp/app.js");
    expect(app).toContain("initEditServiceView();");
    expect(app).toContain('"view-edit-service": "apps"');
    expect(app).toContain('"view-edit-describe": "apps"');
    const sw = await asset("/webapp/service-worker.js");
    expect(sw).toContain('"/views/edit-service.js"');
    expect(sw).toContain('"/lib/editService.js"');
    expect(sw).toContain('SHELL_VERSION = "v78"');
  });
});

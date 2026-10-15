import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

describe("webapp AI-key step", () => {
  it("the key step registers a reusable view with enterBuildKey({contextLabel,onChosen})", async () => {
    const body = await asset("/webapp/views/build-key.js");
    expect(body).toContain('registerView("view-build-key")');
    expect(body).toContain("export function initBuildKeyView");
    expect(body).toContain("export function enterBuildKey");
    // Reuses the existing multi-key store rather than duplicating it.
    expect(body).toContain('from "../providers.js"');
    expect(body).toContain("loadProviders");
    expect(body).toContain("addProvider");
    // Hands the in-memory credential back to the caller.
    expect(body).toContain("onChosen");
  });

  it("saved keys are recalled as a masked slug — the full key is never rendered", async () => {
    const body = await asset("/webapp/views/build-key.js");
    // Slug = provider · label · masked key.
    expect(body).toContain("maskKey");
    expect(body).toContain("slugFor");
    // Masking shows only the first/last few chars (never the whole key).
    expect(body).toContain("k.slice(0, 4)");
    expect(body).toContain("k.slice(-4)");
    // The slug builds from provider + label + masked key, never the raw apiKey.
    expect(body).toMatch(/e\.provider/);
    expect(body).toMatch(/e\.label/);
    // The list/slug must NOT render the raw key anywhere.
    expect(body).not.toMatch(/innerHTML[\s\S]{0,200}e\.apiKey/);
  });

  it("adding a key saves it to the list and does not move the flow on", async () => {
    const view = await asset("/webapp/views/build-key.js");
    expect(view).toContain("addProvider");
    expect(view).toContain("setActive(session.umk, added.id)");
    expect(view).not.toContain("bk-save");
    expect(view).not.toMatch(/addFromForm[\s\S]{0,1200}onChosenCb\(/);

    const html = await asset("/webapp/index.html");
    const section = html.slice(html.indexOf('id="view-build-key"'), html.indexOf('id="view-build-git"'));
    expect(section).toContain("<h2>AI Key</h2>");
    expect(section).toContain("Add an API key");
    expect(section).toContain('id="bk-add">Add key<');
    expect(section).not.toContain("Provide an AI key");
    expect(section).not.toContain('id="bk-save"');
    expect(section).toContain('id="bk-provider"');
    expect(section).toMatch(/id="bk-key"[^>]*type="password"/);
    expect(section).toMatch(/flagshipserver\.com never sees/i);
    // The security note sits below the saved list.
    expect(section.indexOf('id="build-key-saved"')).toBeLessThan(
      section.indexOf("The keys are stored safely in your mobile app and your own servers."),
    );
  });

  it("each saved key has Use this and a confirmed delete, last-used first", async () => {
    const body = await asset("/webapp/views/build-key.js");
    expect(body).toContain("Saved keys");
    expect(body).toContain("Last used");
    expect(body).toContain(">Use this<");
    expect(body).toContain('okLabel: "Delete key"');
    const { orderedEntries, deleteMessage, DELETE_TITLE } = await import(
      pathToFileURL(resolve(__dirname, "..", "public", "webapp", "views", "build-key.js")).href
    );
    expect(orderedEntries([{ id: "a" }, { id: "b" }], "b").map((e: { id: string }) => e.id)).toEqual(["b", "a"]);
    expect(orderedEntries([{ id: "a" }, { id: "b" }], "gone").map((e: { id: string }) => e.id)).toEqual(["a", "b"]);
    expect(DELETE_TITLE).toBe("Delete this key?");
    expect(deleteMessage("Work")).toBe("Work will be removed from this phone. Builds that are already running keep working.");
  });

  it("vibe-code sends the credential on start and handles needsCredential", async () => {
    const body = await asset("/webapp/views/vibe-code.js");
    expect(body).toContain("buildCredential");
    // credential rides the start (and reply) request bodies.
    expect(body).toContain("startBody.credential = credential");
    expect(body).toContain("replyBody.credential = credential");
    // A chat that can continue but has no key on the box asks for one.
    expect(body).toContain("lastState?.needsCredential");
    // A skipped key surfaces a gentle nudge back into the key step.
    expect(body).toContain("r.needsCredential");
    expect(body).toContain("enterBuildKey");
    expect(body).toMatch(/Add an AI key to start/i);
  });
});

describe("webapp Settings AI keys manager", () => {
  it("lists saved keys as masked slugs and supports add/delete", async () => {
    const body = await asset("/webapp/views/settings.js");
    // View: provider + label + masked key (never the full key).
    expect(body).toContain("maskKey");
    expect(body).toContain("loadProviders");
    expect(body).toContain("addProvider");
    expect(body).toContain("removeProvider");
    // No raw key value is ever placed into the rendered card.
    expect(body).not.toMatch(/innerHTML[\s\S]{0,120}e\.apiKey/);
  });

  it("the add form masks the key input and the view shows masked slugs", async () => {
    const html = await asset("/webapp/index.html");
    expect(html).toContain('id="providers-list"');
    expect(html).toContain('id="add-provider-form"');
    expect(html).toMatch(/id="np-key"[^>]*type="password"/);
  });
});

import { describe, expect, it } from "vitest";
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

  it("offers a 'use a different key' form with a Save-on-device toggle", async () => {
    const view = await asset("/webapp/views/build-key.js");
    expect(view).toContain("bk-save");
    expect(view).toContain("addProvider");
    // Save is optional — not saving still hands the credential onward.
    expect(view).toMatch(/Save on this device/i);

    const html = await asset("/webapp/index.html");
    expect(html).toContain('id="view-build-key"');
    expect(html).toContain('id="bk-provider"');
    expect(html).toContain('id="bk-key"');
    expect(html).toContain('id="bk-save"');
    // The key input is masked while typing.
    expect(html).toMatch(/id="bk-key"[^>]*type="password"/);
    // Reassuring copy about where the key lives.
    expect(html).toMatch(/flagshipserver\.com never sees/i);
  });

  it("a pre-existing key gets a clear Confirm affordance", async () => {
    const body = await asset("/webapp/views/build-key.js");
    expect(body).toMatch(/Confirm this key/i);
    expect(body).toContain("data-confirm-id");
    expect(body).toMatch(/Use \$\{slugFor/);
  });

  it("vibe-code sends the credential on start and handles needsCredential", async () => {
    const body = await asset("/webapp/views/vibe-code.js");
    expect(body).toContain("buildCredential");
    // credential rides the start (and reply) request bodies.
    expect(body).toContain("startBody.credential = buildCredential");
    expect(body).toContain("replyBody.credential = buildCredential");
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

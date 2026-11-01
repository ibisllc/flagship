// The server page's "Runtime" section (release plan G2): the presentation against the shared vectors iOS and Android
// also pass, and the section's HTML.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/runtime-verification/vectors.json"), "utf8"),
);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

describe("runtime verification presentation (shared vectors)", () => {
  for (const c of V.cases) {
    it(c.name, async () => {
      const L = await load("lib/runtimeVerification.js");
      const v = L.runtimeView({ runtime: c.view });
      expect(v !== null).toBe(c.expect.present);
      if (!v) return;
      expect(L.platformLabel(v.target)).toBe(c.expect.platform);
      expect(L.flagshipStatus(v)).toEqual(c.expect.flagship);
      expect(L.upstreamStatus(v)).toEqual(c.expect.upstream);
      expect(L.localStatus(v)).toEqual(c.expect.local);
      expect(L.runtimeNotes(v)).toEqual(c.expect.notes);
      expect(L.runtimeCommands(v)).toEqual(c.expect.commands);
    });
  }

  it("the commands name the exact archive, the published manifest and the running executable", () => {
    const all = V.cases[0].expect.commands.map((g: { text: string }) => g.text).join("\n");
    const view = V.cases[0].view;
    for (const s of [view.officialUrl, view.shasumsUrl + ".sig", view.expectedArchiveSha256, view.manifestUrl, view.lockSha256, `sha256sum ${view.executablePath}`, view.expectedExecutableSha256]) {
      expect(all).toContain(s);
    }
  });
});

describe("the server page's Runtime section", () => {
  it("renders every fact the server reported, and nothing for an older server", async () => {
    const S = await load("views/runtime-verification.js");
    expect(S.runtimeSectionHtml({})).toBe("");
    const html: string = S.runtimeSectionHtml({ runtime: V.cases[0].view });
    for (const id of ["runtime-card", "runtime-flagship", "runtime-upstream", "runtime-local", "runtime-expected", "runtime-local-sha", "runtime-source", "runtime-check-btn"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(V.cases[0].view.expectedArchiveSha256);
    expect(html).toContain('class="pill ok" id="runtime-flagship"');
    const swapped = V.cases.find((c: { name: string }) => c.name === "swapped executable");
    const bad: string = S.runtimeSectionHtml({ runtime: swapped.view });
    expect(bad).toContain('class="pill err" id="runtime-local"');
    expect(bad).toContain("not the one its release locks");
  });

  it("escapes what the server sends", async () => {
    const S = await load("views/runtime-verification.js");
    const html: string = S.runtimeSectionHtml({ runtime: { ...V.cases[0].view, version: "<img src=x onerror=1>" } });
    expect(html).not.toContain("<img");
  });
});

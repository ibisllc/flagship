// M9 — the `vibecode-needs-you` cold-start deep-link.
//
// The W10 push (service-worker.js) deep-links to
// `?view=vibecode-chat&sessionId=<id>` when the AI pauses on a tool_use. iOS
// consumes the equivalent `.vibeCodeChat(sessionId:)`. The webapp's boot
// dispatcher had no vibecode-chat target and parseViewQuery dropped sessionId,
// so a cold-start vibecode push never opened the chat. Pin the router plumbing:
//   - parseViewQuery extracts sessionId,
//   - the `vibecode-chat` alias (and the hyphenated spelling) resolves to the
//     registered view-vibecode-chat,
//   - clearViewQuery strips sessionId so the deep-link doesn't re-fire.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadRouter() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "router.js");
  return import(pathToFileURL(path).href);
}

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

/** Stub window.location.search/href + a recording history.replaceState. */
function stubWindow(search: string) {
  const href = `https://webapp.flagshipserver.com/${search}`;
  const replaced: string[] = [];
  (globalThis as { window?: unknown }).window = {
    location: { search, href },
    history: {
      replaceState: (_s: unknown, _t: unknown, url: string) => replaced.push(url),
    },
  };
  return replaced;
}

describe("router parseViewQuery — vibecode-chat deep-link (M9)", () => {
  it("resolves the vibecode-chat alias and carries the sessionId", async () => {
    stubWindow("?view=vibecode-chat&sessionId=sess-abc-42");
    const { parseViewQuery } = await loadRouter();
    const q = parseViewQuery();
    expect(q.view).toBe("view-vibecode-chat");
    expect(q.sessionId).toBe("sess-abc-42");
  });

  it("accepts the hyphenated vibe-code-chat spelling too", async () => {
    stubWindow("?view=vibe-code-chat&sessionId=sess-xyz-99");
    const { parseViewQuery } = await loadRouter();
    const q = parseViewQuery();
    expect(q.view).toBe("view-vibecode-chat");
    expect(q.sessionId).toBe("sess-xyz-99");
  });

  it("sessionId is null when absent (other deep-links unaffected)", async () => {
    stubWindow("?view=home");
    const { parseViewQuery } = await loadRouter();
    const q = parseViewQuery();
    expect(q.view).toBe("view-home");
    expect(q.sessionId).toBeNull();
  });
});

describe("router clearViewQuery — strips sessionId (M9)", () => {
  it("removes sessionId so a cold-start vibecode link can't re-fire", async () => {
    const replaced = stubWindow("?view=vibecode-chat&sessionId=sess-abc-42&keep=1");
    const { clearViewQuery } = await loadRouter();
    clearViewQuery();
    expect(replaced).toHaveLength(1);
    const out = new URL(replaced[0]!);
    expect(out.searchParams.has("sessionId")).toBe(false);
    expect(out.searchParams.has("view")).toBe(false);
    // Unrelated params survive.
    expect(out.searchParams.get("keep")).toBe("1");
  });
});

describe("deepLink dispatch — opens the vibecode chat (M9)", () => {
  const SRC = readFileSync(
    resolve(__dirname, "..", "public", "webapp", "lib", "deepLink.js"),
    "utf8",
  );

  it("dispatches view-vibecode-chat to enterVibeCodeChat with the session id", () => {
    expect(SRC).toContain('view-vibecode-chat');
    expect(SRC).toMatch(/enterVibeCodeChat\(q\.sessionId\)/);
    expect(SRC).toContain("../views/vibecode-chat.js");
  });
});

import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

describe("webapp scratch (vibe-code) chat with attachments", () => {
  it("the view is a multi-turn chat that sends prompt + attachments to the BFF", async () => {
    const body = await asset("/webapp/views/vibe-code.js");
    expect(body).toContain('registerView("view-vibe-code")');
    expect(body).toContain("export function initVibeCodeView");
    expect(body).toContain("export async function enterVibeCode");
    // Starts a session and carries attachments on the turn.
    expect(body).toContain("/api/screens/vibe-code/start");
    expect(body).toMatch(/attachments/);
    // Follow-up turns go to the reply endpoint, also with attachments.
    expect(body).toContain("/reply");
    // Deploy still works.
    expect(body).toContain("/deploy");
  });

  it("reads files client-side to base64 via FileReader and enforces the caps", async () => {
    const body = await asset("/webapp/views/vibe-code.js");
    expect(body).toContain("FileReader");
    expect(body).toContain("readAsDataURL");
    // Caps mirror the server (lib/modelMenu.js holds them).
    expect(body).toContain("MAX_ATTACHMENTS");
    expect(body).toContain("classifyFile(file)");
    const lib = await asset("/webapp/lib/modelMenu.js");
    expect(lib).toMatch(/4 \* MB/); // 4 MB image cap
    expect(lib).toMatch(/256 \* 1024/); // 256 KB text cap
    // base64 image/PDF and text/data attachment shapes sent to the server.
    expect(body).toContain("dataBase64");
    expect(body).toMatch(/kind: "data"/);
    expect(body).toMatch(/kind: "text"/);
  });

  it("renders a message list + removable chips + image thumbnails", async () => {
    const body = await asset("/webapp/views/vibe-code.js");
    expect(body).toContain("vc-messages");
    expect(body).toContain("vc-attach-chips");
    // Image attachments render as a thumbnail data URI.
    expect(body).toContain("data:");
    expect(body).toContain("vc-chip-thumb");
    expect(body).toContain("renderChips");
  });

  it("index.html carries the chat composer with an accessible attach input", async () => {
    const body = await asset("/webapp/index.html");
    expect(body).toContain('id="view-vibe-code"');
    expect(body).toContain('id="vc-messages"');
    expect(body).toContain('id="vc-attach-input"');
    // The attach input accepts images, text/code, CSV/JSON and PDF.
    expect(body).toMatch(/accept="image\/png,image\/jpeg,image\/gif,image\/webp,\.csv,\.json,\.pdf,\.txt,\.md/);
    expect(body).toContain('id="vc-send"');
    // Caps + "not a secret channel" reassurance is visible to the user.
    expect(body).toMatch(/6 files per message/);
    expect(body).toMatch(/4 MB/);
    expect(body).toMatch(/256 KB/);
    expect(body).toMatch(/passwords or keys/i);
    // Friendly, reassuring prompt copy.
    expect(body).toMatch(/Drop a screenshot or a file/i);
  });
});

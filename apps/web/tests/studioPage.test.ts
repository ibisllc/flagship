import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/studio/ — desktop builder download and pairing guide", () => {
  it("shows both available desktop downloads and direct phone-pairing steps", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/studio/" });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Get Flagship Studio");
    expect(r.body).toContain('href="/download/mac"');
    expect(r.body).toContain('href="/download/windows"');
    expect(r.body).toContain("Studio shows a QR code and a short pairing code");
    expect(r.body).toContain("Pair with Studio");
    expect(r.body).toContain("Already downloaded a recipe from the webapp?");
  });

  it("detects the visitor platform only to emphasize a download", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/studio/" });

    expect(r.body).toContain("userAgentData?.platform");
    expect(r.body).toContain('data-platform="mac"');
    expect(r.body).toContain('data-platform="windows"');
    expect(r.body).toContain("is-preferred");
  });
});

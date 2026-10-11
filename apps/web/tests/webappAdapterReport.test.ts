// "Report a problem with this adaptation" (webapp parity of the iOS change):
// the service page offers it for a service built from a shared adaptation,
// and the note goes through the box trimmed.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

async function loadReport() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "adapterReport.js");
  return import(pathToFileURL(path).href);
}

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

describe("adapter report", () => {
  it("sends the trimmed note to the box", async () => {
    const { sendAdapterReport } = await loadReport();
    const fetchJson = vi.fn(async () => ({ ok: true }));
    const r = await sendAdapterReport({ serviceId: "bright-maple--plants", detail: "  the upload page 500s\n", fetchJson });
    expect(r).toEqual({ ok: true });
    expect(fetchJson).toHaveBeenCalledWith("/api/screens/adapter-report/bright-maple--plants", {
      method: "POST",
      body: JSON.stringify({ detail: "the upload page 500s" }),
    });
  });

  it("shows the box's reason, else the usual message", async () => {
    const { sendAdapterReport } = await loadReport();
    const refused = await sendAdapterReport({
      serviceId: "s",
      detail: "broken",
      fetchJson: async () => {
        throw new ScreensError("HTTP 502", 502, { error: "Couldn't send the report. Try again later." });
      },
    });
    expect(refused).toEqual({ ok: false, message: "Couldn't send the report. Try again later." });
    const offline = await sendAdapterReport({
      serviceId: "s",
      detail: "broken",
      fetchJson: async () => {
        throw new ScreensError("not paired to a server yet", 0);
      },
    });
    expect(offline).toEqual({ ok: false, message: "not paired to a server yet" });
  });

  it("refuses an empty or too long note and counts what is typed", async () => {
    const { canSend, counterText, MAX_LENGTH } = await loadReport();
    expect(MAX_LENGTH).toBe(2000);
    expect(canSend("")).toBe(false);
    expect(canSend(" \n ")).toBe(false);
    expect(canSend("x".repeat(2001))).toBe(false);
    expect(canSend("x".repeat(2000))).toBe(true);
    expect(canSend("ok", true)).toBe(false);
    expect(counterText("abc")).toBe("3 / 2000");
  });

  it("says it the way iOS does", async () => {
    const r = await loadReport();
    expect(r.ROW_TITLE).toBe("Report a problem with this adaptation");
    expect(r.rowCaption("github.com/me/app")).toBe("It was set up from a shared adaptation of github.com/me/app");
    expect(r.TITLE).toBe("Report a problem");
    expect(r.PROMPT).toBe("What goes wrong? It helps fix the shared adaptation for everyone.");
    expect(r.WARNING).toBe(
      "Please don't include anything that identifies you, your server or your data: no names, addresses, emails or passwords.",
    );
    expect(r.SENT).toBe("Sent. Thank you.");
    expect(r.SENT_NEXT).toBe("To fix it on your server now, use Edit this service to change it with AI.");
    const row = r.renderReportRow("github.com/me/<app>");
    expect(row).toContain('id="sd-report-adapter"');
    expect(row).toContain("github.com/me/&lt;app&gt;");
  });

  it("the service page offers it only for a service built from a shared adaptation", async () => {
    const js = await asset("/webapp/views/service-detail.js");
    expect(js).toContain('typeof body.adaptedFrom?.repo === "string" ? renderReportRow(body.adaptedFrom.repo) : ""');
    expect(js).toContain('$("sd-report-adapter")?.addEventListener("click"');
    expect(js).toContain("openAdapterReport({ serviceId: s.serviceId");
    const lib = await asset("/webapp/lib/adapterReport.js");
    expect(lib).toContain("send.disabled = !canSend(text.value, sending);");
    expect(lib).toContain("errorEl.textContent = r.message;");
    const sw = await asset("/webapp/service-worker.js");
    expect(sw).toContain('"/lib/adapterReport.js"');
  });
});

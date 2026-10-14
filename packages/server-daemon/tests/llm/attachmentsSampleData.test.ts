/**
 * Sample data and documents in the builder chat: a CSV/JSON file becomes a
 * preview for the model and a file for the private test copy only; a PDF
 * becomes its text, extracted on the box.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATA_PREVIEW_CHARS,
  extractPdfText,
  prepareAttachments,
  sampleFileName,
} from "../../src/llm/vibeCodeAttachments.js";
import { VibeCodeSession } from "../../src/llm/vibeCodeSession.js";
import { StagingRunner } from "../../src/buildmodes/staging.js";
import { DataProvisioner, InMemoryFilesAdmin } from "../../src/dataLayer/index.js";
import { assertNoHostPathInDockerArgs, type CommandRunner } from "../../src/serviceRunner.js";

/** A one-page PDF saying `text`, with a correct xref table. */
function tinyPdf(text: string): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    (() => {
      const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    })(),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

describe("preparing attachments", () => {
  it("gives the model a preview of sample data and keeps the file for the test copy", async () => {
    const csv = ["name,price", ...Array.from({ length: 500 }, (_, i) => `item ${i},${i}.00`)].join("\n");
    const r = await prepareAttachments([{ kind: "data", name: "orders 2026.csv", mediaType: "text/csv", text: csv }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.samples).toEqual([{ name: "orders-2026.csv", mediaType: "text/csv", text: csv }]);
    const a = r.attachments[0]!;
    expect(a.kind).toBe("text");
    if (a.kind !== "text") return;
    expect(a.name).toBe("orders-2026.csv");
    expect(a.text).toContain("$FLAGSHIP_FILES_DIR/sample/orders-2026.csv");
    expect(a.text).toContain("live app starts without it");
    expect(a.text).toContain("item 0,0.00");
    expect(a.text).not.toContain("item 499,");
    expect(a.text.length).toBeLessThan(DATA_PREVIEW_CHARS + 1000);
  });

  it("refuses invalid JSON, other types and oversize data", async () => {
    expect(await prepareAttachments([{ kind: "data", name: "a.json", mediaType: "application/json", text: "{nope" }])).toMatchObject({ ok: false });
    expect(await prepareAttachments([{ kind: "data", name: "a.xlsx", mediaType: "application/vnd.ms-excel", text: "x" }])).toMatchObject({
      ok: false,
      reason: "sample data must be CSV or JSON",
    });
    expect(
      await prepareAttachments([{ kind: "data", name: "big.csv", mediaType: "text/csv", text: "x".repeat(2 * 1024 * 1024 + 1) }]),
    ).toMatchObject({ ok: false, reason: "sample data too large (max 2 MB)" });
  });

  it("extracts a PDF's text on the box", async () => {
    const pdf = tinyPdf("Opening hours 9 to 5");
    expect(await extractPdfText(new Uint8Array(Buffer.from(pdf, "base64")))).toContain("Opening hours 9 to 5");
    const r = await prepareAttachments([
      { kind: "image", mediaType: "image/png", dataBase64: "AAAA", name: "a.png" },
      { kind: "document", name: "menu.pdf", mediaType: "application/pdf", dataBase64: pdf },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachments.map((x) => x.kind)).toEqual(["image", "text"]);
    expect(r.attachments[1]).toMatchObject({ kind: "text", name: "menu.pdf (text)" });
    expect((r.attachments[1] as { text: string }).text).toContain("Opening hours");
    expect(r.samples).toEqual([]);
  });

  it("explains a PDF it can't read, and refuses one over 10 MB", async () => {
    const empty = await prepareAttachments([{ kind: "document", name: "scan.pdf", mediaType: "application/pdf", dataBase64: "AAAA" }], {
      pdfText: async () => "   ",
    });
    expect(empty).toEqual({ ok: false, reason: "scan.pdf has no text to read (a scan?)" });
    const big = await prepareAttachments([
      { kind: "document", name: "big.pdf", mediaType: "application/pdf", dataBase64: "A".repeat(14 * 1024 * 1024) },
    ]);
    expect(big).toEqual({ ok: false, reason: "document too large (max 10 MB)" });
  });

  it("makes sample file names safe", () => {
    expect(sampleFileName("../../etc/passwd", "text/csv")).toBe("passwd");
    expect(sampleFileName(undefined, "application/json")).toBe("sample.json");
    expect(sampleFileName("...", "text/csv")).toBe("sample.csv");
  });

  it("a session keeps sample files across a restart", () => {
    const s = new VibeCodeSession({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    s.addSamples([{ name: "a.csv", mediaType: "text/csv", text: "x,y" }]);
    expect(VibeCodeSession.fromSnapshot(s.toSnapshot()).sampleFiles()).toEqual({ "a.csv": "x,y" });
  });
});

describe("sample data reaches the test copy only", () => {
  it("writes each file into the copy's own files volume, with no network and no host mount", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const cmd: CommandRunner = {
      run: async (_c, args) => void calls.push({ args }),
      capture: async (_c, args, opts) => {
        calls.push({ args, ...(typeof opts?.input === "string" ? { input: opts.input } : {}) });
        return { stdout: "", stderr: "" };
      },
    };
    const files = new InMemoryFilesAdmin();
    const runner = new StagingRunner({
      cmd,
      workingDir: mkdtempSync(join(tmpdir(), "staging-")),
      dataProvisioner: new DataProvisioner({ files }),
      runSql: async () => {},
      startCheck: async () => ({ ok: true }),
      pickPort: () => 51240,
      now: () => 1700000000000,
    });
    const manifest = {
      schema_version: 1,
      name: "orders",
      version: "0.1.0",
      description: "Orders",
      runtime: { image: "flagship/orders:0.1.0", port: 8080 },
      data: { stores: { files: true } },
      network: { subdomain: "orders" },
      access: { enabled: true, default_role: "member", public_routes: [] },
      migration: { verification: "standard" },
    };
    const r = await runner.stage({
      buildId: "s1",
      files: { "flagship.app.json": JSON.stringify(manifest), Dockerfile: "FROM node:20-alpine" },
      slug: "orders",
      sampleFiles: { "orders.csv": "id,total\n1,9.50\n", "../evil": "x" },
    });
    expect(r.ok).toBe(true);
    const seeds = calls.filter((c) => c.args[0] === "run" && c.args.includes("-i"));
    expect(seeds).toHaveLength(1);
    const seed = seeds[0]!;
    expect(seed.input).toBe("id,total\n1,9.50\n");
    expect(seed.args[seed.args.indexOf("--mount") + 1]).toBe("type=volume,src=flagship-devfiles-owner--stg-s1,dst=/data");
    expect(seed.args.slice(seed.args.indexOf("--network"), seed.args.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(seed.args.at(-1)).toBe("orders.csv");
    expect(() => assertNoHostPathInDockerArgs(seed.args)).not.toThrow();
    // Seeded before the copy starts, so it can import them at boot.
    const appRun = calls.findIndex((c) => c.args[0] === "run" && !c.args.includes("-i"));
    expect(calls.indexOf(seed)).toBeLessThan(appRun);
  });

  it("an app without a files folder simply runs without them", async () => {
    const calls: string[][] = [];
    const cmd: CommandRunner = {
      run: async (_c, args) => void calls.push(args),
      capture: async (_c, args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
    };
    const runner = new StagingRunner({
      cmd,
      workingDir: mkdtempSync(join(tmpdir(), "staging-")),
      startCheck: async () => ({ ok: true }),
      pickPort: () => 51241,
      now: () => 1700000000000,
    });
    const manifest = {
      schema_version: 1,
      name: "static",
      version: "0.1.0",
      description: "A page",
      runtime: { image: "flagship/static:0.1.0", port: 8080 },
      network: { subdomain: "static" },
      access: { enabled: true, default_role: "member", public_routes: [] },
      migration: { verification: "standard" },
    };
    const r = await runner.stage({
      buildId: "s2",
      files: { "flagship.app.json": JSON.stringify(manifest), Dockerfile: "FROM node:20-alpine" },
      slug: "static",
      sampleFiles: { "a.csv": "x" },
    });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.includes("-i"))).toBe(false);
  });
});

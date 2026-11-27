import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plan, pngSize, shipped, strings } from "./render.mjs";

const ROOT = path.resolve(__dirname, "../..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "store/store.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/store/en.json"), "utf8"));

describe("store art plan", () => {
  it("names every slide a class asks for, and every caption key a slide uses", () => {
    const ids = new Set(config.slides.map((s: { id: string }) => s.id));
    for (const c of config.classes) for (const id of c.slides) expect(ids.has(id), `${c.class} ${id}`).toBe(true);
    for (const s of config.slides) {
      if (!s.strings) continue;
      expect(en[s.caption ?? `${s.strings}_caption`], s.id).toBeTruthy();
      if (!s.closing && s.id !== "feature") expect(en[`${s.strings}_theme`], s.id).toBeTruthy();
    }
    const used = new Set(config.slides.flatMap((s: { strings?: string; caption?: string; id: string }) =>
      s.strings ? [s.caption ?? `${s.strings}_caption`, `${s.strings}_theme`] : []));
    for (const k of Object.keys(en)) expect(used.has(k), `i18n/store/en.json ${k} is on no slide`).toBe(true);
  });

  it("plans one image per class and slide in every shipped language, plus one icon", () => {
    const perLang = config.classes.filter((c: { neutral?: boolean }) => !c.neutral).reduce((n: number, c: { slides: string[] }) => n + c.slides.length, 0);
    for (const l of shipped()) {
      const jobs = plan(l.code);
      expect(jobs.filter((j: { cls: string }) => j.cls !== "icon")).toHaveLength(perLang);
      expect(new Set(jobs.map((j: { file: string }) => j.file)).size).toBe(jobs.length);
      for (const j of jobs) expect(j.file.startsWith(path.join(ROOT, "store/out"))).toBe(true);
    }
    expect(plan("en").filter((j: { cls: string }) => j.cls === "icon")).toHaveLength(1);
    expect(plan("ja").filter((j: { cls: string }) => j.cls === "icon")).toHaveLength(0);
  });

  it("alternates light and dark by position and files App Store and Play under their own language codes", () => {
    const ja = plan("ja");
    const iphone = ja.filter((j: { cls: string }) => j.cls === "iphone-6.9").map((j: { tone: string }) => j.tone);
    expect(iphone).toEqual(["light", "dark", "light", "dark", "light", "dark", "light"]);
    expect(ja.find((j: { store: string }) => j.store === "playstore")?.storeLang).toBe("ja-JP");
    expect(plan("zh-Hans").find((j: { store: string }) => j.store === "playstore")?.storeLang).toBe("zh-CN");
  });

  it("shows the translated caption, and never puts a caption on a bare watch screen", () => {
    const ja = plan("ja");
    expect(ja.find((j: { cls: string; id: string }) => j.cls === "phone" && j.id === "01")?.caption).toBe(strings("ja").call_anyone_caption);
    for (const j of ja.filter((x: { template: string }) => x.template === "watch")) expect(j.caption).toBeNull();
  });

  it("draws the caller's browser over slide 01 only, and crops the call into the feature graphic", () => {
    const de = plan("de");
    for (const j of de) expect(!!j.inset, `${j.cls} ${j.id}`).toBe(j.id === "01" && !["wear", "watch-ultra"].includes(j.cls));
    expect(de.find((j: { id: string }) => j.id === "01")?.inset?.wanted).toMatch(/store\/captures\/voici\/de\/browser\/01\.png$/);
    expect(de.find((j: { id: string }) => j.id === "feature")?.capture?.wanted).toMatch(/store\/captures\/android\/de\/phone\/01\.png$/);
  });

  it("reads a PNG's size from its header", () => {
    const icon = path.join(ROOT, "apps/mobile/ios/App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
    expect(pngSize(icon)).toEqual([1024, 1024]);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "store-")), "x.png");
    fs.writeFileSync(f, "not a png at all, padded to 24 bytes");
    expect(() => pngSize(f)).toThrow(/not a PNG/);
  });
});

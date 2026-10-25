// The recovery page (recovery.<apex>) in the webapp's language: the webapp names its language in the
// window's fragment, the page's own runtime (recovery/recoveryI18n.js) follows it and otherwise uses the
// shared browser rule, its catalogs hold only its own keys, and every sentence it shows goes through tr().
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("../public/webapp/lib/state.js", () => ({ getSession: () => ({ umk: null, username: null }) }));
vi.mock("../public/webapp/lib/toast.js", () => ({ toast: vi.fn() }));

// @ts-expect-error plain browser module
import { pickLanguage, handedLanguage, languageFor, catalogUrl, tr, trn } from "../public/recovery/recoveryI18n.js";
// @ts-expect-error plain browser module
import { GA_LOCALES, CATALOG_VERSIONS } from "../public/recovery/recoveryI18nLocales.js";
// @ts-expect-error plain browser module
import { pickLanguage as webappPickLanguage } from "../public/webapp/lib/i18n.js";
// @ts-expect-error plain browser module
import { recoveryWindowUrl } from "../public/webapp/lib/recovery.js";

const ROOT = resolve(__dirname, "..", "..", "..");
const RECOVERY = resolve(__dirname, "..", "public", "recovery");
const GA = ["es", "fr", "de", "pt-BR", "ja", "zh-Hans"];

describe("the language hand-off", () => {
  it("the webapp opens the window with its own language after the mode", () => {
    expect(recoveryWindowUrl("recover", "pt-BR")).toBe("https://recovery.flagshipserver.com/#recover&lang=pt-BR");
    expect(recoveryWindowUrl("enroll", "zh-Hans")).toBe("https://recovery.flagshipserver.com/#enroll&lang=zh-Hans");
    // the webapp shows English here (no catalog loaded), so the window is told English
    expect(recoveryWindowUrl("enroll")).toBe("https://recovery.flagshipserver.com/#enroll&lang=en");
  });

  it("the page shows exactly the language it was handed, whatever the browser prefers", () => {
    for (const lang of ["en", ...GA]) {
      const hash = new URL(recoveryWindowUrl("recover", lang)).hash;
      expect(handedLanguage(hash)).toBe(lang);
      expect(languageFor(hash, ["fr-FR", "de"], GA)).toBe(lang);
      expect(languageFor(hash, ["en-US"], GA)).toBe(lang);
    }
  });

  it("a handed language this page does not ship (or a broken one) is English, not a guess of its own", () => {
    expect(languageFor("#recover&lang=it", ["fr"], GA)).toBe("en");
    expect(languageFor("#recover&lang=%E0", ["fr"], GA)).toBe("en");
    expect(languageFor("#recover&lang=", ["fr"], GA)).toBe("en");
  });

  it("opened directly (no lang=), the browser's languages decide by the webapp's rule", () => {
    expect(handedLanguage("#recover")).toBeNull();
    expect(handedLanguage("")).toBeNull();
    expect(languageFor("#enroll", ["ja-JP"], GA)).toBe("ja");
    expect(languageFor("#recover&x=1", ["zh-TW", "de"], GA)).toBe("de");
    expect(languageFor("", ["en-GB", "fr"], GA)).toBe("en");
  });

  it("the mode is still the fragment's first part", () => {
    const page = readFileSync(resolve(RECOVERY, "recovery.js"), "utf8");
    expect(page).toContain('.replace(/^#/, "").split("&")[0].trim().toLowerCase()');
  });

  it("uses the webapp's own pickLanguage, and so the shared negotiation vectors", () => {
    expect(pickLanguage.toString()).toBe(webappPickLanguage.toString());
    const v = JSON.parse(readFileSync(resolve(ROOT, "test-vectors", "language-negotiation.json"), "utf8")) as { ga: string[]; cases: Array<{ accept: string; expect: string }> };
    for (const c of v.cases) {
      const tags = c.accept.split(",").map((p, i) => {
        const [tag, ...params] = p.trim().split(";");
        const q = Number(/q=([\d.]+)/.exec(params.join(";"))?.[1] ?? 1);
        return { tag: (tag ?? "").trim(), q, i };
      }).filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i).map((x) => x.tag);
      expect([c.accept, languageFor("#recover", tags, v.ga)]).toEqual([c.accept, c.expect]);
    }
  });
});

describe("the recovery page's own catalogs", () => {
  const en = JSON.parse(readFileSync(resolve(ROOT, "i18n", "webapp", "en.json"), "utf8")) as Record<string, unknown>;

  it("are the ga languages, fetched from this origin by content hash", () => {
    expect(GA_LOCALES).toEqual(GA);
    expect(readdirSync(resolve(RECOVERY, "i18n")).sort()).toEqual(GA.map((l) => `${l}.json`).sort());
    for (const code of GA) {
      const body = readFileSync(resolve(RECOVERY, "i18n", `${code}.json`), "utf8");
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
      expect(CATALOG_VERSIONS[code]).toBe(hash);
      expect(catalogUrl(code, "https://recovery.example/recoveryI18n.js").href).toBe(`https://recovery.example/i18n/${code}.json?v=${hash}`);
    }
  });

  it("hold the recovery page's sentences, translated, and only keys of i18n/webapp", () => {
    const mustHave = [
      "Use at least 8 characters.",
      "Update your account recovery",
      "Not now",
      "This recovery needs your passkey. Try again and choose your Flagship passkey.",
      "Too many tries for this account name. Try again {0}.",
      "Hardening your passphrase (Argon2id, ~1.5s)…",
    ];
    for (const code of GA) {
      const cat = JSON.parse(readFileSync(resolve(RECOVERY, "i18n", `${code}.json`), "utf8")) as Record<string, string>;
      for (const k of mustHave) expect([code, k, typeof cat[k] === "string" && cat[k] !== k]).toEqual([code, k, true]);
      for (const k of Object.keys(cat)) expect(en[k], k).toBeTruthy();
      // a webapp-only sentence stays out
      expect(cat["Unlock the webapp first."]).toBeUndefined();
    }
  });

  it("tr/trn fall back to the English with arguments when no catalog is loaded", () => {
    expect(tr("Will enrol passkey for: {0}", "alice")).toBe("Will enrol passkey for: alice");
    expect(trn(15, "in about {0} minute", "in about {0} minutes")).toBe("in about 15 minutes");
    expect(trn(1, "in about {0} minute", "in about {0} minutes")).toBe("in about 1 minute");
  });

  it("a translated sentence of index.html is rebuilt from plain inline tags, never assigned as HTML", () => {
    const rt = readFileSync(resolve(RECOVERY, "recoveryI18n.js"), "utf8");
    expect(rt).not.toMatch(/innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write/);
    expect(rt).toContain('const SAFE_TAGS = new Set(["B", "I", "EM", "STRONG", "CODE", "KBD", "SMALL", "BR"]);');
    expect(rt).toContain("el.replaceChildren(frag)");
  });
});

describe("every sentence the recovery page shows goes through tr()", () => {
  const files = ["recovery.js", "recoveryPasskey.js", "recoveryRecordCheck.js", "recoveryWrap.js"];
  // diagnostics that are English by design: protocol reasons for the webapp and internal decoding failures
  const ENGLISH_BY_DESIGN = new Set(["umk missing or wrong shape", "username missing", "invalid hex", "wrapped blob too short"]);

  it("no Error, status line or text it sets is a bare literal", () => {
    const bare: string[] = [];
    for (const f of files) {
      const src = readFileSync(resolve(RECOVERY, f), "utf8");
      const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
      const literal = (n: ts.Node | undefined): string | null => {
        if (!n) return null;
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
        if (ts.isTemplateExpression(n)) return n.getText(sf);
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return literal(n.left) ?? literal(n.right);
        if (ts.isConditionalExpression(n)) return literal(n.whenTrue) ?? literal(n.whenFalse);
        return null;
      };
      const flag = (n: ts.Node | undefined, where: ts.Node) => {
        const text = literal(n);
        if (text !== null && /[A-Za-z]{2}/.test(text) && !ENGLISH_BY_DESIGN.has(text)) bare.push(`${f}:${sf.getLineAndCharacterOfPosition(where.getStart(sf)).line + 1} ${text}`);
      };
      const visit = (n: ts.Node) => {
        if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && /Error$/.test(n.expression.text)) flag(n.arguments?.[0], n);
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          if (n.expression.text === "setStatus") flag(n.arguments[1], n);
          if (n.expression.text === "coded") flag(n.arguments[0], n);
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && ["textContent", "innerText", "title", "placeholder"].includes(n.left.name.text)) flag(n.right, n);
        if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "reason") flag(n.initializer, n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bare).toEqual([]);
  });

  it("the passkey sentences and limits stay the shared English keys", () => {
    const page = readFileSync(resolve(RECOVERY, "recovery.js"), "utf8");
    for (const s of ["This recovery needs your passkey. Try again and choose your Flagship passkey.", "The passkey check expired. Try again.", "That passkey isn't the one your account recovery uses.", "Passkey recovery isn't available right now. Try again later.", "Use at least 8 characters."]) {
      expect(page).toContain(`tr(${JSON.stringify(s)})`);
    }
    expect(page).toContain('import { tr, trn } from "./recoveryI18n.js";');
    // the relying-party name is saved with the passkey: one name in every language
    expect(page).toContain('const RP_NAME = "Flagship recovery"; // i18n: keep');
  });

  it("the webapp's extractor has nothing left to wrap on the recovery page", () => {
    const r = spawnSync("node", [resolve(ROOT, "scripts", "i18n-pwa.mjs"), "extract", "--dry", ...files.map((f) => resolve(RECOVERY, f))], { encoding: "utf8", cwd: ROOT });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^0 files rewritten/m);
  }, 60_000);
});

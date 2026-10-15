import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAllowlist,
  checkFeatures,
  isWebappTest,
  makeRepo,
  parseAasaPaths,
  parseAppLinkPaths,
  parseEmittedDeepLinks,
  parseKotlinDataClasses,
  parseKotlinDeepLink,
  parseManifestAppLinkPaths,
  parseOpenPageLinks,
  parseSwiftDeepLink,
  parseSwiftStructs,
  parseTags,
  parseTsInterfaces,
  parseWebappLandingPaths,
  parseWorkflowPaths,
  readsVectorSet,
  stripComments,
} from "./parity-check.mjs";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "parity-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

describe("parity-check parsers", () => {
  it("reads APP_LINK_PATHS", () => {
    const src = `const APP_LINK_PATHS: ReadonlySet<string> = new Set(\n  ["/join", "/share"]\n    .flatMap((p) => [p, \`\${p}/\`]),\n);`;
    expect(parseAppLinkPaths(src)).toEqual(["/join", "/share"]);
  });

  it("reads AASA components and legacy paths", () => {
    const aasa = JSON.stringify({ applinks: { details: [{ components: [{ "/": "/qr" }, { "/": "/qr/" }], paths: ["/old"] }] } });
    expect(parseAasaPaths(aasa)).toEqual(["/old", "/qr", "/qr/"]);
  });

  it("reads https App Links for one host only", () => {
    const xml = `<data android:scheme="https" android:host="flagshipserver.com" android:path="/join" />
      <data android:scheme="https" android:host="other.com" android:path="/nope" />
      <data android:scheme="flagship" android:host="join" />`;
    expect(parseManifestAppLinkPaths(xml, "flagshipserver.com")).toEqual(["/join"]);
  });

  it("reads the open page's LINKS and their web flag", () => {
    const html = `const LINKS = {\n        "/join": {\n          hl: "x",\n          web: true,\n        },\n        "/qr": {\n          web: false,\n        },\n      };`;
    expect(parseOpenPageLinks(html)).toEqual({ "/join": true, "/qr": false });
  });

  it("reads Swift switch hosts and https paths, ignoring comments", () => {
    const src = `
      if url.path == "/join" { }
      if url.path == Flow.transferLinkPath { }
      switch trimmedPath(url) { case "/remote": return nil }
      // case "commented":
      switch host {
      case "server":
          return nil
      case "secret-requests",
           // a comment between hosts
           "unlock-approve":
          return nil
      case "account":
          switch sub {
          case "nested": return nil
          default: return nil
          }
      default: break
      }`;
    const r = parseSwiftDeepLink(src, { transferLinkPath: "/transfer" });
    expect(r.hosts).toEqual(["account", "secret-requests", "server", "unlock-approve"]);
    expect(r.paths).toEqual(["/join", "/remote", "/transfer"]);
  });

  it("reads Kotlin when-arms, App Link twins and AppLink segments", () => {
    const src = `
      if (uri.path == "/share") {}
      private val APP_LINK_PATHS = listOf("remote", "builder")
      return when (host) {
          "a", "b" -> X
          "join" -> {
              Y
          }
          "settings" -> when (sub) {
              "nested" -> Z
              else -> null
          }
          else -> null
      }`;
    const appLink = `if (segments.size == 1 && segments[0] == "join") {}`;
    const r = parseKotlinDeepLink(src, appLink);
    expect(r.hosts).toEqual(["a", "b", "join", "settings"]);
    expect(r.paths).toEqual(["/builder", "/join", "/remote", "/share"]);
  });

  it("reads webapp landing paths", () => {
    const src = `if (!/\\/join\\/?$/.test(path)) return;
      if (!/^\\/share\\/?$/.test(path)) return;
      if (window.location.pathname.replace(/\\/+$/, "") === "/access") {}
      isAppLink(u, "/remote")`;
    expect(parseWebappLandingPaths(src)).toEqual(["/access", "/join", "/remote", "/share"]);
  });

  it("finds emitted in-app links in strings, not comments", () => {
    const src = `// flagship://commented
      const a = "flagship://install-progress";
      const b = appRouteLink("account/re-pair", { u });
      const c = "https://flagshipserver.com/app/settings/two-factor";
      const d = \`https://\${apex}/app/\${route}\`;`;
    expect(parseEmittedDeepLinks(src)).toEqual(["account/re-pair", "install-progress", "settings/two-factor"]);
  });

  it("keeps URLs inside strings when stripping comments", () => {
    expect(stripComments(`const u = "https://x/y"; // gone`).trim()).toBe(`const u = "https://x/y";`);
  });

  it("reads signed-message tags", () => {
    expect(parseTags(`"flagship/app-copy/v1|x" and 'flagship/server-order/v2'`)).toEqual([
      "flagship/app-copy/v1",
      "flagship/server-order/v2",
    ]);
  });

  it("reads TS interfaces with extends and nested object types", () => {
    const src = `export interface Base { id: string; }
      export interface Row extends Base {
        /** doc */
        name?: string;
        activity?: { kind: "a" | "b" };
        tags: Array<{ x: number }>;
      }`;
    const r = parseTsInterfaces(src);
    expect(r.Row).toEqual(["activity", "id", "name", "tags"]);
  });

  it("reads Swift stored properties, skipping computed and static ones and honouring CodingKeys", () => {
    const src = `public struct Row: Codable {
        public let id: String
        public var name: String? = nil
        public static let shared = Row()
        public var isBig: Bool { name != nil }
        public struct Inner: Codable { public let hidden: Int }
      }
      public struct Renamed: Codable {
        public let wireName: String
        private enum CodingKeys: String, CodingKey { case wireName = "wire_name" }
      }`;
    const r = parseSwiftStructs(src);
    expect(r.Row).toEqual(["id", "name"]);
    expect(r.Inner).toEqual(["hidden"]);
    expect(r.Renamed).toEqual(["wire_name"]);
  });

  it("reads Kotlin data class params and @SerialName", () => {
    const src = `@Serializable
      data class Row(
          val id: String,
          /** doc, with a comma */
          val tags: Map<String, Int> = emptyMap(),
          @SerialName("wire_name") val wireName: String? = null,
      )`;
    expect(parseKotlinDataClasses(src).Row).toEqual(["id", "tags", "wire_name"]);
  });

  it("matches vector sets named as a path or as path segments", () => {
    expect(readsVectorSet(`resolve(d, "../test-vectors/app-copy/vectors.json")`, "app-copy")).toBe(true);
    expect(readsVectorSet(`resolve(d, "..", "test-vectors", "directory-key-delivery.json")`, "directory-key-delivery")).toBe(true);
    expect(readsVectorSet(`"test-vectors/app-copy-extra"`, "app-copy")).toBe(false);
    expect(isWebappTest(`await import("../public/webapp/lib/x.js")`)).toBe(true);
    expect(isWebappTest(`resolve(d, "..", "public", "webapp")`)).toBe(true);
  });

  it("reads workflow path filters", () => {
    const yml = `on:\n  push:\n    paths:\n      - "apps/builder-linux/**"\n      - ".github/workflows/x.yml"\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n`;
    expect(parseWorkflowPaths(yml)).toEqual([".github/workflows/x.yml", "apps/builder-linux/**"]);
  });
});

describe("parity-check feature manifest and allowlist", () => {
  const root = tree({ "a.swift": "struct Thing {}", "b.kt": "nothing here" });
  const repo = makeRepo(root);

  it("fails a present surface whose anchor broke and warns when a missing one appears", () => {
    const r = checkFeatures(repo, {
      features: [
        {
          id: "f",
          ref: "ios",
          surfaces: {
            ios: { status: "present", anchors: [["a.swift", "struct Thing"]] },
            android: { status: "present", anchors: [["b.kt", "class Thing"]] },
            web: { status: "missing", reason: "later", anchors: [["a.swift", "Thing"]] },
            mac: { status: "partial", anchors: [["a.swift", "Thing"]] },
          },
        },
      ],
    });
    expect(r.errors.map((e: { key: string }) => e.key)).toEqual(["f:android", "f:mac"]);
    expect(r.warnings.map((e: { key: string }) => e.key)).toEqual(["f:web"]);
  });

  it("marks allowlisted findings and returns stale entries", () => {
    const results = [{ id: "c", findings: [{ key: "x", message: "" }, { key: "y", message: "" }] }] as Array<{
      id: string;
      findings: Array<{ key: string; message: string; allowed?: string }>;
      red?: number;
      allowed?: number;
    }>;
    const stale = applyAllowlist(results, {
      entries: [
        { check: "c", key: "x", reason: "fine" },
        { check: "c", key: "gone", reason: "old" },
      ],
    });
    expect(results[0]!.red).toBe(1);
    expect(results[0]!.allowed).toBe(1);
    expect(stale.map((e: { key: string }) => e.key)).toEqual(["gone"]);
  });
});

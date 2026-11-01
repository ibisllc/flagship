/**
 * The box release's software bill of materials, CycloneDX 1.5 JSON (release plan G9), taken straight
 * from what the build pinned: package-lock.json (every npm package, its exact version and integrity
 * hash, and whether this artifact actually carries it), rust/Cargo.lock (every crate and its registry
 * checksum), the Go modules' go.sum, and the Node runtime archive. It is what the locks say was used,
 * not a scan. It holds no clock time and no random serial, so the same inputs give the same bytes;
 * its SHA-256 goes into the signed manifest.
 */
import { createHash } from "node:crypto";

interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  hasInstallScript?: boolean;
}

export interface CdxHash {
  alg: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
  content: string;
}
export interface CdxProperty {
  name: string;
  value: string;
}
export interface CdxComponent {
  type: "library" | "application" | "platform";
  "bom-ref": string;
  name: string;
  version: string;
  purl?: string;
  scope?: "required" | "excluded";
  hashes?: CdxHash[];
  externalReferences?: Array<{ type: "distribution" | "vcs"; url: string }>;
  properties?: CdxProperty[];
}

export interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    tools: { components: Array<{ type: "application"; name: string }> };
    component: { type: "application"; "bom-ref": string; name: string; version: string; properties: CdxProperty[] };
    properties: CdxProperty[];
  };
  components: CdxComponent[];
}

export interface SbomInputs {
  npmLock: string;
  cargoLock?: string;
  /** go.sum text by module directory (installer/unseal-helper, installer/tls-frontend). */
  goSums?: Record<string, string>;
  node?: { version: string; file: string; sha256: string; url: string };
  /** Lock paths (`node_modules/x`) present in the artifact; any other lock entry is listed as excluded. */
  installed?: ReadonlySet<string>;
  commit?: string;
  arch?: string;
  sourceDateEpoch?: number;
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

/** An npm integrity string (`sha512-<base64>`, possibly several) as CycloneDX hashes. */
export function integrityHashes(integrity: string | undefined): CdxHash[] {
  const out: CdxHash[] = [];
  for (const tok of (integrity ?? "").split(/\s+/).filter(Boolean)) {
    const m = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(tok);
    if (!m) continue;
    const alg = ({ sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" } as const)[m[1] as "sha1"];
    out.push({ alg, content: Buffer.from(m[2]!, "base64").toString("hex") });
  }
  return out;
}

const npmPurl = (name: string, version: string) =>
  `pkg:npm/${name.startsWith("@") ? "%40" + name.slice(1) : name}@${encodeURIComponent(version)}`;

/** The [[package]] entries of a Cargo.lock (v3/v4): name, version, source and checksum. */
export function parseCargoLock(text: string): Array<{ name: string; version: string; source?: string; checksum?: string }> {
  const out: Array<{ name: string; version: string; source?: string; checksum?: string }> = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (k: string) => new RegExp(`^${k} = "([^"]*)"\\s*$`, "m").exec(block)?.[1];
    const name = field("name");
    const version = field("version");
    if (!name || !version) continue;
    const source = field("source");
    const checksum = field("checksum");
    out.push({ name, version, ...(source ? { source } : {}), ...(checksum ? { checksum } : {}) });
  }
  return out;
}

/** The modules a go.sum pins (the module's own hash line, not its go.mod's). */
export function parseGoSum(text: string): Array<{ module: string; version: string; h1: string }> {
  const out: Array<{ module: string; version: string; h1: string }> = [];
  for (const line of text.split("\n")) {
    const m = /^(\S+) (v\S+?) (h1:\S+)$/.exec(line.trim());
    if (m && !m[2]!.endsWith("/go.mod")) out.push({ module: m[1]!, version: m[2]!, h1: m[3]! });
  }
  return out;
}

const byRef = (a: CdxComponent, b: CdxComponent) => (a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0);

export function buildSbom(input: string | SbomInputs): Sbom {
  const i: SbomInputs = typeof input === "string" ? { npmLock: input } : input;
  const components: CdxComponent[] = [];

  const lock = JSON.parse(i.npmLock) as { packages?: Record<string, LockPackage> };
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (path === "" || p.link || !p.version) continue;
    const idx = path.lastIndexOf("node_modules/");
    // A path outside node_modules is one of our own workspace packages: its code is in the commit, not fetched.
    if (idx < 0) continue;
    const name = path.slice(idx + "node_modules/".length);
    const hashes = integrityHashes(p.integrity);
    const props: CdxProperty[] = [{ name: "flagship:lockPath", value: path }];
    if (p.integrity) props.push({ name: "flagship:npmIntegrity", value: p.integrity });
    if (p.hasInstallScript) props.push({ name: "flagship:installScript", value: "present, not run (npm ci --ignore-scripts)" });
    components.push({
      type: "library",
      "bom-ref": `npm:${path}`,
      name,
      version: p.version,
      purl: npmPurl(name, p.version),
      ...(i.installed ? { scope: i.installed.has(path) ? ("required" as const) : ("excluded" as const) } : {}),
      ...(hashes.length ? { hashes } : {}),
      ...(p.resolved ? { externalReferences: [{ type: "distribution" as const, url: p.resolved }] } : {}),
      properties: props,
    });
  }

  if (i.cargoLock) {
    for (const c of parseCargoLock(i.cargoLock)) {
      // A crate without a source is one of ours (rust/crates): its code is in the commit.
      if (!c.source) continue;
      const git = c.source.startsWith("git+");
      components.push({
        type: "library",
        "bom-ref": `cargo:${c.name}@${c.version}${git ? `#${c.source}` : ""}`,
        name: c.name,
        version: c.version,
        purl: `pkg:cargo/${c.name}@${encodeURIComponent(c.version)}`,
        ...(c.checksum ? { hashes: [{ alg: "SHA-256" as const, content: c.checksum }] } : {}),
        ...(git ? { externalReferences: [{ type: "vcs" as const, url: c.source.slice(4) }] } : {}),
        properties: [{ name: "flagship:cargoSource", value: c.source }],
      });
    }
  }

  for (const [dir, text] of Object.entries(i.goSums ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const g of parseGoSum(text)) {
      const ref = `go:${g.module}@${g.version}`;
      const seen = components.find((c) => c["bom-ref"] === ref);
      if (seen) {
        seen.properties!.push({ name: "flagship:goModuleDir", value: dir });
        continue;
      }
      components.push({
        type: "library",
        "bom-ref": ref,
        name: g.module,
        version: g.version,
        purl: `pkg:golang/${g.module}@${encodeURIComponent(g.version)}`,
        properties: [{ name: "flagship:goSumH1", value: g.h1 }, { name: "flagship:goModuleDir", value: dir }],
      });
    }
  }

  if (i.node) {
    components.push({
      type: "platform",
      "bom-ref": `runtime:node@${i.node.version}`,
      name: "node",
      version: i.node.version,
      purl: `pkg:generic/node@${i.node.version}?download_url=${encodeURIComponent(i.node.url)}`,
      hashes: [{ alg: "SHA-256", content: i.node.sha256 }],
      externalReferences: [{ type: "distribution", url: i.node.url }],
      properties: [{ name: "flagship:archive", value: i.node.file }],
    });
  }
  components.sort(byRef);

  const lockSha256 = sha256(i.npmLock);
  const cargoLockSha256 = i.cargoLock ? sha256(i.cargoLock) : null;
  const seed = sha256([lockSha256, cargoLockSha256 ?? "", i.commit ?? "", i.arch ?? "", i.node?.sha256 ?? ""].join("|"));
  // A name-based UUID (version 5 layout) from the inputs, so two builds of the same inputs agree.
  const variant = ((parseInt(seed[16]!, 16) & 0x3) | 0x8).toString(16);
  const serial = `urn:uuid:${seed.slice(0, 8)}-${seed.slice(8, 12)}-5${seed.slice(13, 16)}-${variant}${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
  const props: CdxProperty[] = [{ name: "flagship:lockSha256", value: lockSha256 }];
  if (cargoLockSha256) props.push({ name: "flagship:cargoLockSha256", value: cargoLockSha256 });
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: serial,
    version: 1,
    metadata: {
      timestamp: new Date((i.sourceDateEpoch ?? 0) * 1000).toISOString(),
      tools: { components: [{ type: "application", name: "flagship tools/box-artifact/sbom.ts" }] },
      component: {
        type: "application",
        "bom-ref": "flagship-box",
        name: "flagship-box",
        version: i.commit ?? "unknown",
        properties: [{ name: "flagship:arch", value: i.arch ?? "unknown" }],
      },
      properties: props,
    },
    components,
  };
}

/** The SHA-256 of the npm lock the SBOM was made from. */
export function sbomLockSha256(s: Sbom): string | undefined {
  return s.metadata.properties.find((p) => p.name === "flagship:lockSha256")?.value;
}

/**
 * Every fetched component must come with a hash: an npm package without its integrity, a registry
 * crate without its checksum. The build refuses either. (A git crate is pinned by its commit.)
 */
export function componentsWithoutIntegrity(s: Sbom): string[] {
  return s.components
    .filter((c) => c.type === "library" && !c.hashes?.length && (c["bom-ref"].startsWith("npm:") || (c["bom-ref"].startsWith("cargo:") && !c["bom-ref"].includes("#git+"))))
    .map((c) => `${c.name}@${c.version}`);
}

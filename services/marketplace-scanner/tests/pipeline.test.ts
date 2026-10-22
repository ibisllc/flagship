/**
 * End-to-end pipeline test driving the INJECTED Trivy seam.
 *
 * Mirrors how `ExecScanRunner` composes `ExecTrivyRunner`: a tiny
 * `TrivyBackedRunner` turns a `TrivyRunner` (here a `FakeTrivyRunner`)
 * into the `ScanArtifacts` the pure core grades — so the whole
 * image-scan → fold → grade → report → signed-post path runs with fake
 * findings and NO git/trivy/docker/network.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  verifyMarketplaceScanResult,
  type Keypair,
} from "@flagship/protocol";
import {
  ScanRunnerError,
  type ReportStore,
  type ResultPoster,
  type ScanArtifacts,
  type ScanRunner,
  type ScanTarget,
} from "../src/ports.js";
import { scanTarget } from "../src/scanner.js";
import {
  FakeTrivyRunner,
  findingsToVulnerabilities,
  type Finding,
  type TrivyRunner,
} from "../src/trivy.js";
import { hexToBytes } from "../src/scanResult.js";

const TREE = "cd".repeat(32);
const TARGET: ScanTarget = {
  creator: "carol",
  slug: "ledger",
  canonicalUrl: "https://github.com/carol/ledger",
  manifestHashHex: TREE,
};

function keypair(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const CLEAN_MANIFEST = {
  canonical: "ledger@carol",
  data: { network: { allowedHosts: ["api.example.com"] } },
  runtime: {},
};

/**
 * The composition under test: a `ScanRunner` whose container-vuln step
 * is the injected `TrivyRunner`. This is the same shape `ExecScanRunner`
 * uses in production, minus the git clone / npm / semgrep execs (faked
 * to clean here so the Trivy findings are the only variable).
 */
class TrivyBackedRunner implements ScanRunner {
  constructor(
    private readonly trivy: TrivyRunner,
    private readonly manifest: unknown = CLEAN_MANIFEST,
    private readonly treeDigestHex: string = TREE,
  ) {}
  async run(_t: ScanTarget): Promise<ScanArtifacts> {
    const findings = await this.trivy.scan(`docker://${_t.creator}/${_t.slug}`);
    return {
      treeDigestHex: this.treeDigestHex,
      manifest: this.manifest,
      trivy: findingsToVulnerabilities(findings),
      npmAudit: { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0 },
      semgrep: { ERROR: 0, WARNING: 0, INFO: 0 },
      raw: { trivy: findings },
    };
  }
}

class FakeStore implements ReportStore {
  public puts: Array<{ key: string; json: string }> = [];
  async put(key: string, json: string): Promise<string> {
    this.puts.push({ key, json });
    return key;
  }
}
class FakePoster implements ResultPoster {
  public posted: Array<{ creator: string; slug: string; body: unknown }> = [];
  async post(creator: string, slug: string, body: unknown): Promise<void> {
    this.posted.push({ creator, slug, body });
  }
}

function deps(runner: ScanRunner, scanner: Keypair) {
  return {
    runner,
    reportStore: new FakeStore(),
    poster: new FakePoster(),
    scanner,
    now: () => 1_800_000_000_000,
  };
}

describe("pipeline with injected Trivy findings → grade", () => {
  const cases: Array<{ name: string; findings: Finding[]; grade: string }> = [
    { name: "no findings ⇒ A", findings: [], grade: "A" },
    { name: "1 HIGH ⇒ B", findings: [{ severity: "HIGH", id: "CVE-1" }], grade: "B" },
    {
      name: "3 HIGH ⇒ C",
      findings: [
        { severity: "HIGH", id: "CVE-1" },
        { severity: "HIGH", id: "CVE-2" },
        { severity: "HIGH", id: "CVE-3" },
      ],
      grade: "C",
    },
    { name: "1 CRITICAL ⇒ F", findings: [{ severity: "CRITICAL", id: "CVE-boom" }], grade: "F" },
    {
      name: "MEDIUM/LOW only do not drop A",
      findings: [
        { severity: "MEDIUM", id: "CVE-m" },
        { severity: "LOW", id: "CVE-l" },
      ],
      grade: "A",
    },
  ];

  it.each(cases)("$name", async ({ findings, grade }) => {
    const scanner = keypair(11);
    const d = deps(new TrivyBackedRunner(new FakeTrivyRunner(findings)), scanner);
    const out = await scanTarget(d, TARGET);

    expect(out.result.grade).toBe(grade);
    // The report records the trivy tally derived from the findings.
    const expectedTrivy = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const f of findings) expectedTrivy[f.severity]++;
    expect(out.report.trivy).toEqual(expectedTrivy);
    // Every outcome is a verifiable signed post.
    const body = (d.poster as FakePoster).posted[0]!.body as { request: unknown; signature: string };
    expect(
      verifyMarketplaceScanResult(out.result, hexToBytes(body.signature), scanner.publicKey),
    ).toBe(true);
  });

  it("the imageRef reaches the injected TrivyRunner", async () => {
    const fake = new FakeTrivyRunner([]);
    const d = deps(new TrivyBackedRunner(fake), keypair(12));
    await scanTarget(d, TARGET);
    expect(fake.scanned).toEqual([`docker://${TARGET.creator}/${TARGET.slug}`]);
  });

  it("a Trivy runner that throws fails the whole scan closed to F (never a pass)", async () => {
    const scanner = keypair(13);
    const runner = new TrivyBackedRunner(
      new FakeTrivyRunner(new ScanRunnerError("trivy timed out", "tool-timeout")),
    );
    const d = deps(runner, scanner);
    const out = await scanTarget(d, TARGET);
    expect(out.result.grade).toBe("F");
    expect(out.report.scanError).toBe("tool-timeout");
    // Still signed + uploaded an error report.
    expect((d.reportStore as FakeStore).puts).toHaveLength(1);
    expect((d.poster as FakePoster).posted).toHaveLength(1);
  });

  it("a manifest no-ship check dominates even with zero Trivy findings", async () => {
    const scanner = keypair(14);
    const runner = new TrivyBackedRunner(new FakeTrivyRunner([]), {
      canonical: "ledger@carol",
      data: { network: { allowedHosts: ["*"] } }, // wildcard ⇒ no-ship
      runtime: {},
    });
    const out = await scanTarget(deps(runner, scanner), TARGET);
    expect(out.result.grade).toBe("F");
    expect(out.report.reasons.join(" ")).toMatch(/no-ship/);
  });
});

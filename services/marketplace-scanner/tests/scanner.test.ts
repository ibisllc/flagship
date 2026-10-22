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
import {
  assess,
  reportKeyFor,
  scanTarget,
  serializeReport,
  type ScanCoreDeps,
} from "../src/scanner.js";
import {
  hexToBytes,
  scannerKeypairFromHex,
  signScanResult,
  verifyScanResult,
} from "../src/scanResult.js";

function keypair(seedByte: number): Keypair {
  const priv = new Uint8Array(32).fill(seedByte);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const TREE = "ab".repeat(32);

const TARGET: ScanTarget = {
  creator: "alice",
  slug: "habit-tracker",
  canonicalUrl: "https://github.com/alice/habit-tracker",
  manifestHashHex: TREE,
};

function cleanArtifacts(overrides: Partial<ScanArtifacts> = {}): ScanArtifacts {
  return {
    treeDigestHex: TREE,
    manifest: { canonical: "habit-tracker@alice", data: { network: { allowedHosts: ["api.example.com"] } }, runtime: {} },
    trivy: [],
    npmAudit: { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0 },
    semgrep: { ERROR: 0, WARNING: 0, INFO: 0 },
    raw: {},
    ...overrides,
  };
}

class FakeRunner implements ScanRunner {
  constructor(private readonly outcome: ScanArtifacts | Error) {}
  async run(_t: ScanTarget): Promise<ScanArtifacts> {
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

class FakeStore implements ReportStore {
  public puts: Array<{ key: string; json: string }> = [];
  constructor(private readonly fail = false) {}
  async put(key: string, json: string): Promise<string> {
    if (this.fail) throw new Error("R2 down");
    this.puts.push({ key, json });
    return key;
  }
}

class FakePoster implements ResultPoster {
  public posted: Array<{ creator: string; slug: string; body: unknown }> = [];
  constructor(private readonly fail = false) {}
  async post(creator: string, slug: string, body: unknown): Promise<void> {
    if (this.fail) throw new Error(".com rejected");
    this.posted.push({ creator, slug, body });
  }
}

function deps(
  runner: ScanRunner,
  store: FakeStore,
  poster: FakePoster,
  scanner: Keypair,
  extra: Partial<ScanCoreDeps> = {},
): ScanCoreDeps {
  return { runner, reportStore: store, poster, scanner, now: () => 1_700_000_000_000, ...extra };
}

describe("signed postback round-trips through the LANDED verifyMarketplaceScanResult", () => {
  it("construct → sign → verify === ok with the matching scanner pubkey", () => {
    const scanner = keypair(7);
    const result = {
      creator: "alice",
      slug: "habit-tracker",
      grade: "A" as const,
      reportKey: "alice/habit-tracker/abc.json",
      imageDigestHex: TREE,
      scannedAt: 1_700_000_000_000,
    };
    const body = signScanResult(result, scanner);
    // Verify with the SAME function .com runs (imported from protocol).
    expect(
      verifyMarketplaceScanResult(body.request, hexToBytes(body.signature), scanner.publicKey),
    ).toBe(true);
    // And via our thin wrapper.
    expect(verifyScanResult(result, body.signature, bytesToHex(scanner.publicKey))).toBe(true);
  });

  it("tamper with ANY envelope field ⇒ landed verifier rejects", () => {
    const scanner = keypair(9);
    const result = {
      creator: "bob",
      slug: "notes",
      grade: "B" as const,
      reportKey: "bob/notes/x.json",
      imageDigestHex: TREE,
      scannedAt: 1_700_000_000_000,
    };
    const body = signScanResult(result, scanner);
    const sig = hexToBytes(body.signature);
    for (const tampered of [
      { ...result, grade: "A" as const },
      { ...result, creator: "mallory" },
      { ...result, slug: "other" },
      { ...result, reportKey: "evil.json" },
      { ...result, imageDigestHex: "00".repeat(32) },
      { ...result, scannedAt: result.scannedAt + 1 },
    ]) {
      expect(verifyMarketplaceScanResult(tampered, sig, scanner.publicKey)).toBe(false);
    }
  });

  it("a signature from a different key is rejected (only the scanner can post)", () => {
    const scanner = keypair(1);
    const attacker = keypair(2);
    const result = {
      creator: "alice",
      slug: "habit-tracker",
      grade: "A" as const,
      reportKey: "k.json",
      imageDigestHex: TREE,
      scannedAt: 1_700_000_000_000,
    };
    const forged = signScanResult(result, attacker);
    expect(
      verifyMarketplaceScanResult(forged.request, hexToBytes(forged.signature), scanner.publicKey),
    ).toBe(false);
  });

  it("scannerKeypairFromHex rejects non-32-byte keys (no weak-key bypass)", () => {
    expect(() => scannerKeypairFromHex("ab")).toThrow();
    expect(() => scannerKeypairFromHex("zz".repeat(32))).toThrow();
    const kp = scannerKeypairFromHex("11".repeat(32));
    expect(kp.publicKey.length).toBe(32);
  });
});

describe("scanTarget end-to-end with fakes (no git/trivy/semgrep/npm/network)", () => {
  it("clean tree ⇒ A, report uploaded, signed result posted + verifiable", async () => {
    const scanner = keypair(3);
    const store = new FakeStore();
    const poster = new FakePoster();
    const out = await scanTarget(deps(new FakeRunner(cleanArtifacts()), store, poster, scanner), TARGET);

    expect(out.result.grade).toBe("A");
    expect(out.posted).toBe(true);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.key).toBe(reportKeyFor("alice", "habit-tracker", TREE));
    expect(poster.posted).toHaveLength(1);

    const body = poster.posted[0]!.body as { request: typeof out.result; signature: string };
    expect(
      verifyMarketplaceScanResult(body.request, hexToBytes(body.signature), scanner.publicKey),
    ).toBe(true);
    expect(body.request.imageDigestHex).toBe(TREE);
  });

  it("dirty findings still produce a verifiable signed post", async () => {
    const scanner = keypair(4);
    const store = new FakeStore();
    const poster = new FakePoster();
    const out = await scanTarget(
      deps(
        new FakeRunner(cleanArtifacts({ trivy: [{ Severity: "HIGH", VulnerabilityID: "CVE-1" }] })),
        store,
        poster,
        scanner,
      ),
      TARGET,
    );
    expect(out.result.grade).toBe("B");
    const body = poster.posted[0]!.body as { request: typeof out.result; signature: string };
    expect(
      verifyMarketplaceScanResult(body.request, hexToBytes(body.signature), scanner.publicKey),
    ).toBe(true);
  });
});

describe("FAIL-CLOSED end-to-end — runner error never skips, never passes", () => {
  it("ScanRunnerError ⇒ F, still uploads error report, still posts a SIGNED F", async () => {
    const scanner = keypair(5);
    const store = new FakeStore();
    const poster = new FakePoster();
    const out = await scanTarget(
      deps(new FakeRunner(new ScanRunnerError("git exploded", "clone-failed")), store, poster, scanner),
      TARGET,
    );
    expect(out.result.grade).toBe("F");
    expect(out.report.scanError).toBe("clone-failed");
    expect(out.posted).toBe(true);
    // The fail-closed result is STILL scanner-signed (no unsigned path).
    const body = poster.posted[0]!.body as { request: typeof out.result; signature: string };
    expect(
      verifyMarketplaceScanResult(body.request, hexToBytes(body.signature), scanner.publicKey),
    ).toBe(true);
    expect(body.request.grade).toBe("F");
  });

  it("a non-ScanRunnerError thrown by the runner is still fail-closed to F", async () => {
    const scanner = keypair(6);
    const out = await scanTarget(
      deps(new FakeRunner(new Error("OOM killed")), new FakeStore(), new FakePoster(), scanner),
      TARGET,
    );
    expect(out.result.grade).toBe("F");
    expect(out.report.scanError).toBe("runner-threw");
  });

  it("clone-hash-mismatch (runner returned a tree != pinned hash) ⇒ F, not the clean grade", async () => {
    const scanner = keypair(7);
    const out = await scanTarget(
      deps(
        new FakeRunner(cleanArtifacts({ treeDigestHex: "ff".repeat(32) })),
        new FakeStore(),
        new FakePoster(),
        scanner,
      ),
      TARGET,
    );
    // Tree was "clean" but its hash != the pinned manifest hash:
    // MUST fail closed to F, never inherit the clean A.
    expect(out.result.grade).toBe("F");
    expect(out.report.scanError).toBe("clone-hash-mismatch");
    expect(out.result.imageDigestHex).toBe(TARGET.manifestHashHex);
  });

  it("an R2 upload failure does NOT upgrade the grade and still posts the signed result", async () => {
    const scanner = keypair(8);
    const poster = new FakePoster();
    const out = await scanTarget(
      deps(new FakeRunner(cleanArtifacts()), new FakeStore(true), poster, scanner),
      TARGET,
    );
    expect(out.result.grade).toBe("A"); // unchanged by upload failure
    expect(out.posted).toBe(true);
    expect(poster.posted).toHaveLength(1);
  });

  it("dry-run signs but does NOT upload or post", async () => {
    const scanner = keypair(9);
    const store = new FakeStore();
    const poster = new FakePoster();
    const out = await scanTarget(
      deps(new FakeRunner(cleanArtifacts()), store, poster, scanner, { dryRun: true }),
      TARGET,
    );
    expect(out.posted).toBe(false);
    expect(store.puts).toHaveLength(0);
    expect(poster.posted).toHaveLength(0);
    // Still signed + verifiable so an operator can inspect the bytes.
    expect(
      verifyMarketplaceScanResult(
        out.signedBody.request,
        hexToBytes(out.signedBody.signature),
        scanner.publicKey,
      ),
    ).toBe(true);
  });
});

describe("report assembly determinism", () => {
  it("same artifacts ⇒ byte-identical serialized report", () => {
    const a = assess(TARGET, cleanArtifacts(), 1234);
    const b = assess(TARGET, cleanArtifacts(), 1234);
    expect(serializeReport(a.report)).toBe(serializeReport(b.report));
  });

  it("the report records the scan error verbatim on a fail-closed path", () => {
    const { report } = assess(
      TARGET,
      new ScanRunnerError("trivy timed out", "tool-timeout"),
      999,
    );
    expect(report.grade).toBe("F");
    expect(report.scanError).toBe("tool-timeout");
    expect(report.treeDigestHex).toBe(TARGET.manifestHashHex);
  });

  it("reportKeyFor is stable + collision-free per tree digest", () => {
    expect(reportKeyFor("a", "b", "c")).toBe("a/b/c.json");
    expect(reportKeyFor("a", "b", "c")).toBe(reportKeyFor("a", "b", "c"));
  });
});

describe("ScanRunner port contract (fakes substitute the real tools)", () => {
  it("a runner that resolves ScanArtifacts is graded; one that throws fails closed", async () => {
    const scanner = keypair(2);
    const ok = await scanTarget(
      deps(new FakeRunner(cleanArtifacts()), new FakeStore(), new FakePoster(), scanner),
      TARGET,
    );
    expect(ok.result.grade).toBe("A");

    const bad = await scanTarget(
      deps(
        new FakeRunner(new ScanRunnerError("semgrep missing", "semgrep-failed")),
        new FakeStore(),
        new FakePoster(),
        scanner,
      ),
      TARGET,
    );
    expect(bad.result.grade).toBe("F");
  });
});

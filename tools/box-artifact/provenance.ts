/**
 * The box release's provenance: an in-toto Statement v1 with a SLSA Provenance v1 predicate (release
 * plan G9, Appendix G section 4). It names what was built (the artifact and its SBOM, by SHA-256), from
 * what (the exact commit, the npm and Cargo locks, the Node archive, the toolchain pins), with which
 * tools (their reported versions) and by whom (the builder: the release workflow, or an owner's own
 * build, which never claims to be the endorsed builder). Its SHA-256 goes into the signed manifest.
 *
 * It is not signed on its own: the release signature over the manifest covers it. Two builders of
 * the same commit produce the same artifact digest but different provenance (each names itself);
 * docs/architecture-v2/owner-builds.md says what that means for an owner's build.
 */
export const BUILD_TYPE = "https://flagshipserver.com/build/box-artifact/v1";
export const OWNER_LOCAL_BUILDER = "https://flagshipserver.com/build/owner-local/v1";

export interface ProvenanceInput {
  artifact: { name: string; sha256: string };
  sbom: { name: string; sha256: string };
  commit: string;
  arch: string;
  sequence: number;
  sourceDateEpoch: number;
  repository?: string;
  /** Inputs by name: the locks, the Node archive, the toolchain files. */
  materials: Array<{ uri: string; sha256: string }>;
  /** Tool name to its reported version (node, npm, typescript, go, rustc, cargo). */
  toolchain: Record<string, string>;
  builder: { id: string; runId?: string | null; workflow?: string | null; runner?: string | null };
  steps: string[];
  /** Flags that change the output: --no-rust, prebuilt binaries, a skipped PGP check. */
  flags?: string[];
}

export interface InTotoStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicateType: "https://slsa.dev/provenance/v1";
  predicate: {
    buildDefinition: {
      buildType: string;
      externalParameters: { commit: string; arch: string; sequence: number; repository: string | null };
      internalParameters: { sourceDateEpoch: number; steps: string[]; flags: string[] };
      resolvedDependencies: Array<{ uri: string; digest: Record<string, string> }>;
    };
    runDetails: {
      builder: { id: string; version: Record<string, string> };
      metadata: { invocationId: string | null; workflow: string | null; runner: string | null };
    };
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

export function buildProvenance(i: ProvenanceInput): InTotoStatement {
  if (!/^[0-9a-f]{40}$/.test(i.commit)) throw new Error("provenance needs the full 40-hex commit");
  for (const d of [i.artifact.sha256, i.sbom.sha256, ...i.materials.map((m) => m.sha256)]) {
    if (!HEX64.test(d)) throw new Error(`not a SHA-256: ${d}`);
  }
  if (!i.builder.id) throw new Error("provenance needs a builder id");
  const repo = i.repository ?? null;
  const toolchain = Object.fromEntries(Object.entries(i.toolchain).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: i.artifact.name, digest: { sha256: i.artifact.sha256 } },
      { name: i.sbom.name, digest: { sha256: i.sbom.sha256 } },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: { commit: i.commit, arch: i.arch, sequence: i.sequence, repository: repo },
        internalParameters: { sourceDateEpoch: i.sourceDateEpoch, steps: i.steps, flags: [...(i.flags ?? [])].sort() },
        resolvedDependencies: [
          { uri: `git+${repo ?? "flagship"}@${i.commit}`, digest: { gitCommit: i.commit } },
          ...[...i.materials].sort((a, b) => (a.uri < b.uri ? -1 : 1)).map((m) => ({ uri: m.uri, digest: { sha256: m.sha256 } })),
        ],
      },
      runDetails: {
        builder: { id: i.builder.id, version: toolchain },
        metadata: { invocationId: i.builder.runId ?? null, workflow: i.builder.workflow ?? null, runner: i.builder.runner ?? null },
      },
    },
  };
}

/** The builder id for this process: the GitHub workflow when it runs in Actions, else an owner's local build. */
export function builderId(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  if (explicit) return explicit;
  if (env["GITHUB_ACTIONS"] === "true" && env["GITHUB_WORKFLOW_REF"]) return `https://github.com/${env["GITHUB_WORKFLOW_REF"]}`;
  return OWNER_LOCAL_BUILDER;
}

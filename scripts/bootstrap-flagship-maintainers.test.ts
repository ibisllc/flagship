/**
 * `scripts/bootstrap-flagship-maintainers.mjs` produces Flagship's own
 * `.maintainers/` folder from a fixed seed. The contract:
 *
 *   1. Running the script in a clean directory writes the expected file
 *      layout (README, three tracks with their root v2 mandates, two
 *      key files). **LOCKED Phase-2 v2 model**: there is NO `policy.json`
 *      (root or per-track) — the succession rule is folded inline into
 *      each root `MandateV2`.
 *   2. The produced folder is **byte-identical** across runs — same
 *      fixed seeds, same fixed timestamps, same uuids.
 *   3. The produced mandate chain verifies cleanly under
 *      `@maintainers/protocol`'s v2 verifier — the script doesn't just
 *      emit JSON, it emits the actual cryptographic chain we'd ship.
 *      Each track is anchored FORWARD from its first (only) on-repo
 *      mandate's `mandatePinHash` (the no-baked-pin preview anchor; the
 *      real trust is the pin a downstream consumer bakes — see
 *      verify-endorsement.mjs / releaseVerifier.ts).
 *
 * If any of these break, contributors will silently re-derive a
 * different chain on their machines and the in-repo bytes will drift.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentAuthorityV2,
  mandatePinHash,
  verifyMandateChainFromPin,
  type MandateV2,
} from "@maintainers/protocol";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "bootstrap-flagship-maintainers.mjs");
const REPO_ROOT = path.resolve(HERE, "..");
const COMMITTED = path.join(REPO_ROOT, ".maintainers");

function runScriptInto(targetRoot: string): void {
  // The script writes to `<repoRoot>/.maintainers`. We make a temp clone
  // of the repo root just deep enough that the script can locate
  // `@maintainers/protocol` via the npm workspace symlink — so we
  // construct a directory tree that contains `node_modules` plus the
  // script itself, and invoke node from there.
  fs.mkdirSync(path.join(targetRoot, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(targetRoot, "scripts", path.basename(SCRIPT)));
  // Symlink node_modules so `import "@maintainers/protocol"` resolves.
  fs.symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(targetRoot, "node_modules"),
    "dir",
  );
  // Also link maintainers/ so the workspace symlink target exists.
  fs.symlinkSync(
    path.join(REPO_ROOT, "maintainers"),
    path.join(targetRoot, "maintainers"),
    "dir",
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(targetRoot, "scripts", path.basename(SCRIPT)),
    ],
    { cwd: targetRoot, encoding: "utf8" },
  );
}

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(root, full);
        const h = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        out[rel] = h;
      }
    }
  }
  walk(root);
  return out;
}

describe("bootstrap-flagship-maintainers.mjs", () => {
  it("produces the documented folder layout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-maintainers-emit-"));
    try {
      runScriptInto(tmp);
      const dotMaintainers = path.join(tmp, ".maintainers");
      expect(fs.existsSync(path.join(dotMaintainers, "README.md"))).toBe(true);
      // v2: NO root policy.json (succession policy is inline in each
      // root mandate — the unsigned-policy hole is dissolved).
      expect(fs.existsSync(path.join(dotMaintainers, "policy.json"))).toBe(false);
      for (const track of ["release", "ca", "ops"]) {
        // v2: NO per-track policy.json either.
        expect(
          fs.existsSync(path.join(dotMaintainers, "tracks", track, "policy.json")),
        ).toBe(false);
        expect(
          fs.existsSync(
            path.join(dotMaintainers, "tracks", track, "mandates", "2026-05-11-genesis.json"),
          ),
        ).toBe(true);
      }
      expect(
        fs.existsSync(path.join(dotMaintainers, "keys", "harry@flagship.services.json")),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(dotMaintainers, "keys", "harrybackup@flagship.services.json"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent — two clean runs produce byte-identical bytes", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-maintainers-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-maintainers-b-"));
    try {
      runScriptInto(a);
      runScriptInto(b);
      const ha = hashTree(path.join(a, ".maintainers"));
      const hb = hashTree(path.join(b, ".maintainers"));
      expect(hb).toEqual(ha);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("the committed .maintainers/ matches what the script would emit", () => {
    // Catches the case where someone hand-edits a committed file: re-run
    // the script and compare. If this test ever fails, the fix is to
    // run `node scripts/bootstrap-flagship-maintainers.mjs` and commit
    // the result.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-maintainers-cmp-"));
    try {
      runScriptInto(tmp);
      const fresh = hashTree(path.join(tmp, ".maintainers"));
      const committed = hashTree(COMMITTED);
      expect(fresh).toEqual(committed);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the emitted v2 mandate chain verifies under @maintainers/protocol", () => {
    for (const track of ["release", "ca", "ops"]) {
      const mandate = JSON.parse(
        fs.readFileSync(
          path.join(COMMITTED, "tracks", track, "mandates", "2026-05-11-genesis.json"),
          "utf8",
        ),
      ) as MandateV2;
      // It is a v2 root mandate with inline succession policy (no
      // policy.json — that file does not exist in v2).
      expect(mandate.version).toBe(2);
      expect(mandate.approvalRule).toEqual({ kind: "threshold", threshold: 1 });
      expect(mandate.minSuccessors).toBe(1);
      expect(mandate.project?.name).toBe("Flagship");
      // Anchor FORWARD from the first (only) on-repo mandate's pin —
      // the no-baked-pin preview anchor the verify-endorsement helper
      // and the daemon's releaseVerifier use.
      const pin = mandatePinHash(mandate);
      const chain = verifyMandateChainFromPin(pin, [mandate]);
      expect(chain.rootError).toBeUndefined();
      expect(chain.root).not.toBeNull();
      expect(chain.rejections).toEqual([]);
      expect(chain.validMandates).toHaveLength(1);
      const authority = currentAuthorityV2(
        chain,
        new Date("2026-05-11T12:00:00.000Z"),
      );
      expect(authority?.holder).toBe(mandate.holder);
      // The backup pubkey is listed as a successor on every track —
      // under the inline 1-of-N approvalRule it can sign the next
      // mandate on lapse.
      expect(authority?.successors).toHaveLength(2);
    }
  });
});

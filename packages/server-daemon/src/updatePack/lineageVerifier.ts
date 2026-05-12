/**
 * Lineage verifier for update-packs.
 *
 * Update-packs distribute app code updates from the canonical-creator pod
 * to install pods. The "lineage" is the chain of commits anchored at the
 * commit hash the install pod first pulled at install time — every
 * subsequent pack must extend that chain. A break means the canonical
 * home was either replaced, force-pushed, or the creator handed the
 * publishing key to someone the install pod has never trusted before.
 *
 * Why this is its own module:
 *   - The verifier is a pure decision function: given a new pack tip,
 *     a previously-applied tip, and the original lineage anchor, decide
 *     whether the new pack chains. The decision is testable in isolation
 *     against a real (or fake) git repo without standing up the rest of
 *     the puller.
 *   - The puller (updateClient.ts) and the phone-resolve path (the BFF
 *     endpoint /api/screens/lineage-resolve) both need to make this
 *     decision — the former to refuse pulls, the latter to surface the
 *     "is this still broken?" status to the phone view.
 *
 * Threat model. A malicious creator (or someone who has stolen the
 * creator's git push access) could try to push a pack whose tip does
 * NOT extend the install pod's existing history. Three concrete attacks
 * the verifier must catch:
 *
 *   1. Lineage-anchor severance — the install pod's anchor commit
 *      isn't reachable from the new pack's tip. Means: someone rebuilt
 *      the repo from scratch and force-pushed. The user has never
 *      consented to running that code.
 *
 *   2. Current-tip severance — the install pod's current tip IS in
 *      the original lineage but is NOT an ancestor of the new pack's
 *      tip. Means: the creator rewrote history above where we already
 *      are. The new tree may contain malicious code we've already
 *      vetoed. Treat as a break.
 *
 *   3. Empty / unreachable tip — the new pack tip can't be resolved
 *      against the local clone (the bundle was empty, malformed, or
 *      referenced a missing commit). Treat as a break — refuse to
 *      advance until the user re-validates.
 *
 * On `ok: false`, the daemon:
 *   - Refuses to apply the pack (keeps running the current installed
 *     version indefinitely).
 *   - Marks the app as `lineagePaused: true` durably in `AppPullState`.
 *   - Emits a `lineage-break` phone alert with enough context (creator,
 *     prior tip, new tip) for the user to investigate.
 *
 * The user retains explicit control: tap "accept" on the phone to
 * adopt the new lineage (the verifier's anchor is rolled forward to
 * the new tip and `lineagePaused` is cleared), or tap "revoke" to
 * uninstall the app.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type LineageVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "anchor-unreachable"
        | "prior-tip-not-ancestor"
        | "new-tip-unresolvable"
        | "missing-input";
      /** Human-friendly explanation; safe to surface to the phone view. */
      detail: string;
    };

export interface LineageVerifierInput {
  /** Local working-tree clone where refs can be resolved. */
  workDir: string;
  /**
   * The commit this pod first pulled at install time. The trust root —
   * every subsequent pack's tip must descend from this.
   */
  lineageAnchor: string;
  /**
   * The commit the pod is currently running. The new pack's tip must
   * also descend from this (otherwise the creator rewrote history above
   * us, replacing already-applied code).
   */
  previouslyAppliedTip: string;
  /**
   * The new pack's tip — typically the `incoming-main` ref the puller
   * just fetched into the local clone from the bundle.
   */
  newPackTip: string;
  /** Override for tests; defaults to the system `git`. */
  gitBinary?: string;
}

export class LineageVerifier {
  private readonly gitBinary: string;

  constructor(opts?: { gitBinary?: string }) {
    this.gitBinary = opts?.gitBinary ?? "git";
  }

  async verify(input: LineageVerifierInput): Promise<LineageVerdict> {
    if (!input.workDir || !input.lineageAnchor || !input.newPackTip) {
      return {
        ok: false,
        reason: "missing-input",
        detail: "workDir + lineageAnchor + newPackTip are all required",
      };
    }

    // Resolve the new tip. If git can't find it, the pack was empty or
    // malformed — refuse the advance. (The puller catches the empty
    // case earlier as kind:no-op; this is a defense in depth.)
    const resolved = await this.tryResolve(input.workDir, input.newPackTip);
    if (!resolved) {
      return {
        ok: false,
        reason: "new-tip-unresolvable",
        detail: `new pack tip ${input.newPackTip} can't be resolved in the local clone`,
      };
    }

    // 1. Anchor must be reachable from the new tip.
    const anchorReachable = await this.isAncestor(
      input.workDir,
      input.lineageAnchor,
      input.newPackTip,
    );
    if (!anchorReachable) {
      return {
        ok: false,
        reason: "anchor-unreachable",
        detail: `lineage anchor ${shortHash(input.lineageAnchor)} is not an ancestor of new pack tip ${shortHash(input.newPackTip)}`,
      };
    }

    // 2. Current tip must also be reachable (no history rewrite above
    // where we already are). When previouslyAppliedTip === lineageAnchor
    // (first pull after install) the first check already covers us.
    if (input.previouslyAppliedTip && input.previouslyAppliedTip !== input.lineageAnchor) {
      const tipReachable = await this.isAncestor(
        input.workDir,
        input.previouslyAppliedTip,
        input.newPackTip,
      );
      if (!tipReachable) {
        return {
          ok: false,
          reason: "prior-tip-not-ancestor",
          detail: `previously-applied tip ${shortHash(input.previouslyAppliedTip)} is not an ancestor of new pack tip ${shortHash(input.newPackTip)} — history was rewritten`,
        };
      }
    }

    return { ok: true };
  }

  private async tryResolve(workDir: string, ref: string): Promise<boolean> {
    try {
      await this.git(workDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async isAncestor(workDir: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(workDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  private git(workDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP(this.gitBinary, ["-C", workDir, ...args], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}

function shortHash(h: string): string {
  return h.length > 12 ? h.slice(0, 12) : h;
}

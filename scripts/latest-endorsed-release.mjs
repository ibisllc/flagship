#!/usr/bin/env node
// Prints the newest maintainer-endorsed release commit in this checkout, as a
// box would judge it: signatures verified against the baked pin and the
// endorsement's lineage walked in git (packages/server-daemon's own verifier).
// The VM appliance is built from it, so a new box starts on signed code.
// Needs `npx tsc -b` and a full-history checkout.
import { execFileSync } from "node:child_process";
import { MAINTAINER_PINNED_MANDATE_HASH } from "@flagship/protocol";
import { verifyEndorsementChainAgainstGit, verifyMaintainersFolder } from "../packages/server-daemon/dist/releaseVerifier.js";

const repo = process.argv[2] ?? ".";
const status = verifyMaintainersFolder({ gitRepoPath: repo, pinnedMandateHash: MAINTAINER_PINNED_MANDATE_HASH });
const onBranch = (commit) => {
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const newest = [...(status?.validEndorsements ?? [])]
  .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
  .find((e) => onBranch(e.commitHash) && verifyEndorsementChainAgainstGit(e, repo).ok);
if (!newest) {
  console.error("no endorsed release verifies in this checkout");
  process.exit(1);
}
console.error(`newest endorsed release: ${newest.semverTag}`);
console.log(newest.commitHash);

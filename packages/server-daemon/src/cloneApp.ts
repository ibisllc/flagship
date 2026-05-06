/**
 * Initial git materialization for cross-creator installs.
 *
 * When Bob installs Alice's `game1`, the daemon needs the git working
 * tree on disk so the container's bind-mount has files and so future
 * incremental pulls can run `git fetch <bundle> main:incoming-main`
 * + `merge-base --is-ancestor`. This module performs that initial
 * fetch using the same `/.flagship/update` endpoint the steady-state
 * pull scheduler uses — `since=""` causes the canonical home to send
 * the full history bundle.
 *
 * Auth is the daemon's server-identity Ed25519 key (the .com-registered
 * pubkey for this server FQDN). The canonical home verifies the sig
 * + checks the puller is in the subscriber list (or `distribution.public`
 * is set). Failed clones are surfaced; the install wrapper is the one
 * that decides whether to abort or proceed without a working tree.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signUpdatePull,
  type Keypair,
  type UpdatePullRequest,
} from "@flagship/protocol";

const execFileP = promisify(execFile);

export interface CloneAppDeps {
  /** This box's server identity keypair. */
  identity: Keypair;
  /** This box's FQDN. */
  pullerServerId: string;
  /** Where to put the working tree per app. */
  appWorkingDir: (appId: string) => string;
  /** Override fetch for tests. */
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  gitBinary?: string;
  now?: () => number;
}

export function buildCloneApp(
  deps: CloneAppDeps,
): (args: {
  appId: string;
  canonicalUrl: string;
}) => Promise<{ currentTip: string }> {
  const fetcher = deps.fetch ?? ((u: string | URL, i?: RequestInit) => fetch(u, i));
  const gitBinary = deps.gitBinary ?? "git";
  const now = deps.now ?? Date.now;
  const git = (cwd: string, args: string[]) =>
    execFileP(gitBinary, ["-C", cwd, ...args], {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });

  return async function cloneApp(args: {
    appId: string;
    canonicalUrl: string;
  }): Promise<{ currentTip: string }> {
    const [creator, slug] = parseAppId(args.appId);
    const workDir = deps.appWorkingDir(args.appId);

    // Fresh init: erase prior partial clone, init bare, then fetch.
    // We use a non-bare repo so the bind-mounted source tree is checkout-able.
    if (existsSync(workDir)) {
      await rm(workDir, { recursive: true, force: true });
    }
    await mkdir(workDir, { recursive: true });
    await git(workDir, ["init", "-q", "--initial-branch=main"]);

    // Sign the pull (since="" → full bundle).
    const pull: UpdatePullRequest = {
      pullerServerId: deps.pullerServerId,
      creator,
      slug,
      since: "",
      issuedAt: now(),
    };
    const sig = signUpdatePull(pull, deps.identity);
    const url = `https://${args.canonicalUrl}/.flagship/update`;
    const headers = new Headers();
    headers.set("x-flagship-update-pull", JSON.stringify(pull));
    headers.set(
      "authorization",
      `Flagship-Identity ${bytesToHex(deps.identity.publicKey)} ${bytesToHex(sig)}`,
    );

    const res = await fetcher(url, { method: "GET", headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`clone fetch ${res.status}: ${text.slice(0, 200)}`);
    }
    const bundleBytes = Buffer.from(await res.arrayBuffer());
    if (bundleBytes.length === 0) {
      // Canonical home is empty — install proceeds with an empty repo.
      return { currentTip: "" };
    }

    const tmp = await mkdtemp(join(tmpdir(), "flagship-clone-"));
    const bundlePath = join(tmp, "incoming.bundle");
    try {
      await writeFile(bundlePath, bundleBytes);
      await git(workDir, ["fetch", bundlePath, "main:main"]);
      const tip = (await git(workDir, ["rev-parse", "main"])).stdout.trim();
      await git(workDir, ["checkout", "main"]);
      return { currentTip: tip };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };
}

function parseAppId(appId: string): [string, string] {
  const i = appId.indexOf("--");
  if (i < 0) throw new Error(`appId ${appId} not in <creator>--<slug> form`);
  return [appId.slice(0, i), appId.slice(i + 2)];
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

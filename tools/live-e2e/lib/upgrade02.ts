/**
 * Pure pieces of the F9 lanes (tools/live-e2e/lanes/upgrade-02.ts): 0.2 clients under 0.3.
 */

/** "0.3" >= "0.3", "0.10" > "0.9"; anything unreadable is false. */
export function productAtLeast(versionJson: unknown, want: string): boolean {
  const have = typeof versionJson === "object" && versionJson !== null ? (versionJson as { product?: unknown }).product : undefined;
  if (typeof have !== "string" || !/^\d+(\.\d+)*$/.test(have) || !/^\d+(\.\d+)*$/.test(want)) return false;
  const a = have.split(".").map(Number);
  const b = want.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The commit `git ls-remote <url> refs/heads/<branch>` names, or null. */
export function parseLsRemote(out: string, ref = "refs/heads/main"): string | null {
  for (const line of out.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

export interface PodView {
  registered: boolean;
  heartbeat: boolean;
  /** `/pods` updateRequired.reason, or null when `.com` asks for no update. */
  updateRequired: string | null;
  certificate: boolean;
}

/** What `/pods` says about one box, for the 0.2-box lane. */
export function podView(row: Record<string, unknown> | undefined): PodView {
  if (!row) return { registered: false, heartbeat: false, updateRequired: null, certificate: false };
  const ur = row.updateRequired as { reason?: unknown } | null | undefined;
  return {
    registered: typeof row.identityPubKey === "string" && row.identityPubKey.length > 0,
    heartbeat: row.lastReported != null,
    updateRequired: ur && typeof ur.reason === "string" ? ur.reason : null,
    certificate: row.currentCert != null,
  };
}

/** The 0.3 engine's refusal of a recipe that names a branch instead of a commit (packages/flagship-builder userdata.ts). */
export const BRANCH_REF_REFUSAL = /exact 40-character commit/;

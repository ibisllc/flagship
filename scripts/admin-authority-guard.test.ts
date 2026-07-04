import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-test for the Slice D admin-authority guard (docs/device-admin-tier-spec.md
// §3.4). The guard asserts every SENSITIVE `.com` handler routes its order
// authorization through the master-admin gate (authorizeSensitiveComOp /
// requireMasterAdmin / signerRoot) and never verifies an order against a raw
// owner-IRK token. It ENFORCES under ADMIN_AUTHORITY_ENFORCE=1 and is ADVISORY
// (reports, exits 0) otherwise — mirroring scripts/release-guard.sh.

const SCRIPT = join(__dirname, "admin-authority-guard.sh");

function run(env?: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("admin-authority-guard.sh — against the real repo (all sensitive .com ops gated)", () => {
  it("enforce mode: every sensitive handler is gated → exits 0 + OK", () => {
    const r = run({ ADMIN_AUTHORITY_ENFORCE: "1" });
    expect(r.stdout).toContain("OK");
    expect(r.code).toBe(0);
  });

  it("advisory mode (default): also exits 0", () => {
    const r = run({ ADMIN_AUTHORITY_ENFORCE: "" });
    expect(r.code).toBe(0);
  });
});

describe("admin-authority-guard.sh — against fixtures (a violation trips the gate)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function makeTree(handlerBody: string): string {
    const d = mkdtempSync(join(tmpdir(), "admin-authority-guard-"));
    // The gate's allowlist references real repo paths; a fixture only needs the
    // ONE file/function the negative case targets to exist with a violation, and
    // every OTHER allowlisted file to be gate-clean. Simplest: copy the real
    // sensitive files into the fixture, then overwrite the one under test.
    const realRoot = join(__dirname, "..");
    for (const rel of ALLOWLIST_FILES) {
      const src = join(realRoot, rel);
      const dst = join(d, rel);
      mkdirSync(join(dst, ".."), { recursive: true });
      writeFileSync(dst, readFileSync(src, "utf8"));
    }
    // Overwrite customDomain's handler with the supplied (possibly bad) body.
    writeFileSync(
      join(d, "packages/control-plane/src/customDomain.ts"),
      handlerBody,
    );
    return d;
  }

  it("a sensitive handler that verifies against the raw owner-IRK FAILS enforce", () => {
    dir = makeTree(
      [
        "export async function handleSetCustomDomain(deps, body) {",
        "  const userRec = await deps.usernames.get(u);",
        "  if (!verifySetCustomDomain(claim, sig, hexToBytes(userRec.irkPubHex))) {",
        "    return forbidden('invalid signature');",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const r = run({ ADMIN_AUTHORITY_ENFORCE: "1", ADMIN_AUTHORITY_GUARD_ROOT: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("RAW OWNER-IRK VERIFY");
    // The SAME violation is only ADVISORY (exit 0) without the enforce flag.
    const adv = run({ ADMIN_AUTHORITY_ENFORCE: "", ADMIN_AUTHORITY_GUARD_ROOT: dir });
    expect(adv.code).toBe(0);
    expect(adv.stderr).toContain("RAW OWNER-IRK VERIFY");
  });

  it("a sensitive handler with NO gate token FAILS enforce", () => {
    dir = makeTree(
      [
        "export async function handleSetCustomDomain(deps, body) {",
        "  // no gate, no verify — just missing the master-admin routing entirely",
        "  return ok({ recorded: true });",
        "}",
        "",
      ].join("\n"),
    );
    const r = run({ ADMIN_AUTHORITY_ENFORCE: "1", ADMIN_AUTHORITY_GUARD_ROOT: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NO GATE");
  });

  it("the gated form (closure through authorizeSensitiveComOp) PASSES", () => {
    dir = makeTree(
      [
        "export async function handleSetCustomDomain(deps, body) {",
        "  const authz = await authorizeSensitiveComOp(deps, {",
        "    username: u, userRec,",
        "    verifyWith: (pub) => verifySetCustomDomain(claim, sig, hexToBytes(pub)),",
        "  });",
        "  if (!authz.ok) return forbidden('invalid signature');",
        "}",
        "",
      ].join("\n"),
    );
    const r = run({ ADMIN_AUTHORITY_ENFORCE: "1", ADMIN_AUTHORITY_GUARD_ROOT: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
  });
});

// The allowlisted sensitive-handler FILES (used to seed the fixture tree). Kept
// in sync with SENSITIVE_HANDLERS in admin-authority-guard.sh.
const ALLOWLIST_FILES = [
  "packages/control-plane/src/customDomain.ts",
  "packages/control-plane/src/certRevocation.ts",
  "packages/control-plane/src/accountDeletion.ts",
  "packages/control-plane/src/serverDecommission.ts",
  "packages/control-plane/src/serverMigration.ts",
  "packages/control-plane/src/serverTransfer.ts",
  "packages/control-plane/src/serverRevoke.ts",
  "packages/control-plane/src/watchDelegates.ts",
  "packages/control-plane/src/entitlementRevocations.ts",
  "packages/control-plane/src/luksKeys.ts",
  "packages/control-plane/src/serviceInvites.ts",
  "packages/control-plane/src/secretMailbox.ts",
  "packages/control-plane/src/deviceCapabilityGrants.ts",
];

describe("admin-authority-guard.sh — the allowlist matches the §2 sensitive .com set", () => {
  it("the script enumerates every sensitive .com handler", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const expected = [
      "customDomain.ts|handleSetCustomDomain",
      "certRevocation.ts|handleSoftRevoke",
      "certRevocation.ts|handleHardRevoke",
      "accountDeletion.ts|handleAccountDeletionBundle",
      "serverDecommission.ts|handlePostDecommission",
      "serverMigration.ts|handlePostMigrationStart",
      "serverMigration.ts|handlePostMigrationConfirmReady",
      "serverMigration.ts|handlePostMigrationAbort",
      "serverTransfer.ts|handlePostTransferOffer",
      "serverTransfer.ts|handlePostTransferClaim",
      "serverRevoke.ts|handleServerReleaseName",
      "watchDelegates.ts|handleMintWatchDelegate",
      "watchDelegates.ts|handleRevokeWatchDelegate",
      "entitlementRevocations.ts|handlePostEntitlementRevocations",
      "luksKeys.ts|handleDepositAutoUnlockLease",
      "luksKeys.ts|handleRevokeAutoUnlockLease",
      "serviceInvites.ts|handleCreateServiceInvite",
      "serviceInvites.ts|handleRevokeServiceInvite",
      "secretMailbox.ts|handlePostSetLeaderDeposit",
      "deviceCapabilityGrants.ts|handleMintDeviceGrant",
    ];
    for (const e of expected) expect(script).toContain(e);
  });
});

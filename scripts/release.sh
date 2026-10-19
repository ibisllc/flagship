#!/usr/bin/env bash
#
# release.sh: take current origin/main to a full production release, by hand.
#
# The owner runs this from a terminal. It walks docs/runbooks/final-deploy.md
# step by step in two phases, asks before every command that changes anything
# outside the local checkout, and never reads, echoes or stores a secret:
# wrangler, flyctl, gh and the Apple tools prompt or use their own login, the
# YubiKey tools read their PIN from /dev/tty, and FLAGSHIP_ADMIN_SECRET comes
# only from a silent prompt (kept in memory, handed to the child processes that
# need it, unset on exit).
#
#   bash scripts/release.sh --phase A      deploy the real state (before the Windows test)
#   bash scripts/release.sh --phase B      after the Windows results: scrub, reap, Studio, stores
#
#   bash scripts/release.sh --list [--short]       print the plan (every step: phase, commands, gate, rollback)
#   bash scripts/release.sh --dry-run [--phase P]  print every command of the steps that would run; run nothing
#   bash scripts/release.sh --status               the pinned sha, finished steps, the next step
#   bash scripts/release.sh --from N | --only N    resume at, or run only, step N
#   bash scripts/release.sh --new                  start a fresh release (the old state file is kept aside)
#   bash scripts/release.sh --force-phase-order    run phase B before phase A is finished (asks for a typed reason)
#
# The release is pinned to ONE commit (origin/main when the run starts). Every
# build happens in a clean worktree of that commit with its own npm ci, never in
# the shared checkout. If origin/main moves, the next step stops and asks to
# re-pin. State lives in ~/.flagship-release/state.json (not in the repo), so a
# failed run resumes at the failed step.
#
# The script never force-pushes, never calls the Worker upload tool directly
# (only `npm run deploy` in apps/com), never stages with a catch-all add, and
# has no flag that answers its prompts for you.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMON_DIR="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$REPO/.git")"
MAIN_CHECKOUT="$(dirname "$COMMON_DIR")"
RELEASE_HOME="${FLAGSHIP_RELEASE_HOME:-$HOME/.flagship-release}"
STATE="$RELEASE_HOME/state.json"
WT="$RELEASE_HOME/worktree"
LOCKDIR="$RELEASE_HOME/lock"
ARTIFACTS="$HOME/flagship-release-artifacts"
RESULTS_BRANCH="device-results/windows-2026-10-17"
COM_URL="https://flagshipserver.com"
SERVICES_URL="https://flagship.services"
WEBAPP_URL="https://webapp.flagshipserver.com"
REMOTE_URL="https://remote.flagshipserver.com"
BOOT_URL="https://boot.flagshipserver.com"
SHIM_URL="https://inference.flagshipserver.com"
export PATH="$HOME/.fly/bin:$PATH"

DRY=0
PIN=""
CURRENT_STEP=""
PROBE_FAILS=0
ADMIN_SECRET=""
HAVE_LOCK=0
LAST_RC=0

# ---------------------------------------------------------------- output

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_B=$'\033[1m'; C_D=$'\033[2m'; C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_B=""; C_D=""; C_R=""; C_G=""; C_Y=""; C_C=""; C_0=""
fi
say()  { printf '%s\n' "$*"; }
hdr()  { printf '\n%s== %s ==%s\n' "$C_B$C_C" "$*" "$C_0"; }
ok()   { printf '%s  ok%s   %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%s  warn%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
err()  { printf '%s  FAIL%s %s\n' "$C_R" "$C_0" "$*" >&2; }
fail() { err "$*"; exit 1; }

# ---------------------------------------------------------------- state

# One tiny node helper owns the JSON file (atomic write, mode 600).
ST_JS='
const fs=require("fs"),path=require("path");
const [f,op,k,v]=process.argv.slice(1);
let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
const w=()=>{fs.mkdirSync(path.dirname(f),{recursive:true});const t=f+".tmp";fs.writeFileSync(t,JSON.stringify(s,null,2)+"\n",{mode:0o600});fs.renameSync(t,f)};
switch(op){
 case "get": console.log(s[k]===undefined?"":(Array.isArray(s[k])?s[k].join(" "):String(s[k])));break;
 case "set": s[k]=v;w();break;
 case "add": s[k]=s[k]||[];if(!s[k].includes(v))s[k].push(v);w();break;
 case "del": s[k]=(s[k]||[]).filter(x=>x!==v);w();break;
 case "has": process.exit((s[k]||[]).includes(v)?0:1);
 default: process.exit(2);
}'
st()   { node -e "$ST_JS" -- "$STATE" "$@"; }
st_w() { if [ "$DRY" = 1 ]; then return 0; fi; st "$@"; }
st_has() { [ -f "$STATE" ] && st has "$1" "$2"; }
st_get() { if [ -f "$STATE" ]; then st get "$1"; fi; }

# ---------------------------------------------------------------- the plan

STEP_IDS=(preflight plan lease endorse kickoff secrets gym backup migrations services dns com cpu publish redeployA status
          notice scrub reap retire studiowl studiomac publisharm redeployB ios android final)
LAST_A=16   # the last step of phase A (status)

step_id()    { echo "${STEP_IDS[$(($1 - 1))]}"; }
step_count() { echo "${#STEP_IDS[@]}"; }
step_phase() { if [ "$1" -le "$LAST_A" ]; then echo A; else echo B; fi; }
phase_first() { if [ "$1" = A ]; then echo 1; else echo $((LAST_A + 1)); fi; }
phase_last()  { if [ "$1" = A ]; then echo "$LAST_A"; else step_count; fi; }

TITLE=""; WHAT=""; RUNBOOK=""; CMDS=""; GATE=""; ROLLBACK=""; REQUIRED=0; OUTWARD=1

meta_preflight() {
  TITLE="Preflight: tools, logins, disk, build, checks"
  RUNBOOK="0. What \"ready\" means before you start"
  OUTWARD=0
  WHAT="Checks the tools and logins, builds the pinned commit in a clean worktree, and runs the same gates the runbook calls 'ready'."
  read -r -d '' CMDS <<'EOF' || true
git worktree add --detach ~/.flagship-release/worktree <PIN> && npm ci
gh auth status; wrangler whoami; flyctl auth whoami; df (needs > 5 GB free)
npx tsc -b
node scripts/check-versions.mjs
npm run parity
RELEASE=1 bash scripts/release-guard.sh
npx vitest run <touched packages>   (quick)   or   npx vitest run   (full)
EOF
  GATE="Every command above exits 0; the tool versions print; both logins show the right accounts."
  ROLLBACK="Nothing changes outside the local worktree."
}
meta_plan() {
  TITLE="Cloudflare plan and DNS limits (acknowledge)"
  RUNBOOK="1. Cloudflare plan and DNS limits (do this first)"
  OUTWARD=0
  WHAT="Records which Workers plan .com runs on (Free today) and prints the limits and the signals that mean upgrade."
  read -r -d '' CMDS <<'EOF' || true
(no command: a typed answer, free or paid)
open https://dash.cloudflare.com -> Workers & Pages -> flagship-com -> Settings (shows the plan)
EOF
  GATE="You typed free or paid; on Free you accept the 10 ms CPU, 100,000 requests a day, 50 subrequests limits and the D1 backup moving to GitHub Actions."
  ROLLBACK="A plan change is reversible in the dashboard."
}
meta_lease() {
  TITLE="CA lease: check the expiry, renew with the YubiKey"
  RUNBOOK="2. Renew the CA lease (due 2026-11-05, and do it before anything that needs the CA)"
  WHAT="Reads the real expiry from .maintainers/ca-endorsements/bundle.json, previews and (on your yes) signs a new 30 day lease, regenerates bundle.json, commits and pushes it to main, then re-pins."
  read -r -d '' CMDS <<'EOF' || true
node scripts/rotate-ca.mjs status
node <maintainers clone>/packages/cli/bin/maintainers ca-endorsement --ca-pubkey <hex> --scope flagship/directory-attestation --duration 30d --track ca --signing-key yubikey-piv:slot=9c --path <worktree>/.maintainers --dry-run
(same, without --dry-run: YubiKey PIN + touch, type CA-LEASE)
node -e '<regenerate .maintainers/ca-endorsements/bundle.json>'
git add -- .maintainers/ca-endorsements && git commit -m "Renew the production CA lease"
git push origin HEAD:main            (then the pin moves to this commit)
EOF
  GATE="bundle.json lists the new lease with a later notAfter; rotate-ca status shows it LIVE."
  ROLLBACK="A lease is additive: nothing to undo; a wrong one is superseded by signing another."
}
meta_endorse() {
  TITLE="Endorse the release commit (YubiKey), push, re-pin"
  RUNBOOK="3. Endorse a server release (only if the box code changed)"
  REQUIRED=1
  WHAT="Shows what box code changed since the newest endorsement, previews the endorsement, signs it on your yes, commits it to main and re-pins so every later step deploys a tree that contains it."
  read -r -d '' CMDS <<'EOF' || true
node scripts/latest-endorsed-release.mjs
git diff --stat <endorsed>..<PIN> -- packages/server-daemon installer packages/boot-core packages/protocol packages/tunnel-protocol packages/llm-providers package.json package-lock.json
node scripts/endorse-release.mjs --to <PIN> --from <endorsed>            (preview: no signature, no write)
node scripts/endorse-release.mjs --to <PIN> --from <endorsed> --sign     (YubiKey PIN + touch)
git add -- .maintainers/endorsements && git commit -m "Endorse <sha> on the ca track"
git push origin HEAD:main            (then the pin moves to the endorsement commit)
node scripts/latest-endorsed-release.mjs                                 (must now print <PIN>)
EOF
  GATE="latest-endorsed-release prints the commit you signed; origin/main is the endorsement commit."
  ROLLBACK="An endorsement cannot be un-signed: do not order the update and endorse a newer fix. A box whose update fails its health gate rolls itself back."
}
meta_kickoff() {
  TITLE="Start the VM appliance builds (GitHub Actions)"
  RUNBOOK="9. Publish the VM appliances"
  WHAT="Dispatches vm-appliance.yml for amd64 and arm64 now that the endorsement is on main, so the one to three hour builds run while you deploy."
  read -r -d '' CMDS <<'EOF' || true
gh workflow run vm-appliance.yml --ref main -f arch=amd64 -f git_ref=main -f release=latest-endorsed
gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=latest-endorsed
gh run list --workflow vm-appliance.yml --limit 4
EOF
  GATE="Both runs show as queued or in progress on the pinned commit."
  ROLLBACK="gh run cancel <id>. Nothing leaves GitHub and no secrets are involved."
}
meta_secrets() {
  TITLE="Secrets the new code reads (names only, read-only)"
  RUNBOOK="5. Secrets and settings the new code reads"
  OUTWARD=0
  WHAT="Lists secret names on prod and on the gym Worker and flags the names the runbook says new code reads; values are never shown."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && wrangler secret list)
(cd apps/com && wrangler secret list --config wrangler.gym.toml)
EOF
  GATE="No known secret name is missing on prod, or you accept the missing ones (create with: wrangler secret put NAME)."
  ROLLBACK="Read-only."
}
meta_gym() {
  TITLE="Gym gate: the root wildcard proven live (you verify)"
  RUNBOOK="6. Gym refresh and live verification of the root wildcard (GATE: nothing deploys to prod until this passes)"
  REQUIRED=1
  OUTWARD=0
  WHAT="Prints the gym go/no-go checklist; this script cannot verify it, so you type 'verified' once the gym run is green on the commit you will deploy. The static-only webapp Worker is NOT exercised by the gym: the .com post-checks are its first real test."
  read -r -d '' CMDS <<'EOF' || true
(you run, in another terminal, from the shared checkout, when no other live run is in progress:)
  bash scripts/gym-refresh.sh
  npx tsx tools/live-e2e/shared-run.ts
  npx tsx tools/live-e2e/dns-ent-experiment.ts --canary
EOF
  GATE="You typed: verified"
  ROLLBACK="No-go blocks the prod deploys: fix on main, rerun gym-refresh, run again."
}
meta_backup() {
  TITLE="D1 backup prerequisites: bucket, secrets, age key, first backup (BEFORE .com)"
  RUNBOOK="1b. Free-plan prerequisites: GitHub secrets, the backup bucket, the first backup"
  WHAT="Follows runbook step 1b: the private bucket with its 30-day rule on d1/daily/, the two repo secrets, a real age public key, then runs d1-backup.yml and model-capabilities.yml once and verifies latest.json. The .com deploy removes the Worker's own backup, so this MUST be done before it; the .com step refuses without it."
  read -r -d '' CMDS <<'EOF' || true
gh secret list                      (names CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
cat .maintainers/backup-recipient.pub   (a real age1... public key, not the placeholder)
wrangler r2 bucket list             (flagship-d1-backups)
wrangler r2 bucket lifecycle list flagship-d1-backups           (the d1/daily/ 30 day rule)
(if absent, on your yes:) wrangler r2 bucket create flagship-d1-backups
                          wrangler r2 bucket lifecycle add flagship-d1-backups expire-daily d1/daily/ --expire-days 30
gh workflow run d1-backup.yml --ref main ; gh run watch <id> --exit-status
wrangler r2 object get flagship-d1-backups/latest.json --file <tmp> --remote      (takenAt fresh, tables > 0, key under d1/daily/)
gh workflow run model-capabilities.yml --ref main ; gh run watch <id> --exit-status
EOF
  GATE="d1-backup.yml is green and latest.json is fresh (taken in the last 15 minutes) with a key under d1/daily/; model-capabilities.yml is green."
  ROLLBACK="None needed: the workflows only read D1 and write the new bucket."
}
meta_migrations() {
  TITLE="Pending D1 migrations (check, apply, stamp the ledger)"
  RUNBOOK="4. Pending D1 migrations"
  WHAT="Compares packages/storage/migrations with the prod schema_version ledger (read-only) and applies each pending file after its own confirm."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && wrangler d1 execute flagship-state --remote --json --command "SELECT version FROM schema_version")
for each pending file, in order:
  (cd apps/com && wrangler d1 execute flagship-state --remote --file=../../packages/storage/migrations/<file>)
  (cd apps/com && wrangler d1 execute flagship-state --remote --command "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES ('<NNNN>', <ms>)")
EOF
  GATE="A second read of the ledger lists every repo migration."
  ROLLBACK="There are no down-migrations: roll the code back, leave additive tables, forward-fix. Data damage: docs/runbooks/d1-restore.md."
}
meta_com() {
  TITLE="Deploy .com (Cloudflare Worker) and check it"
  RUNBOOK="7. Deploy \`.com\` (two Workers)"
  REQUIRED=1
  WHAT="Runs 'npm run deploy' in apps/com in the foreground of your terminal: the guards, then the NEW static-only Worker flagship-webapp, then flagship-com. The first run moves the webapp. and remote. custom domains and wrangler ASKS to confirm: answer yes. Refuses without the D1 backup step. Then probes the webapp and remote hosts (200, strict CSP), the tree's shell version, the marketing page, health, notices, account-not-found, the boot route, the shim, and runs zone-health as a post-check."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && wrangler deployments list)         (the rollback target)
(cd apps/com && npm run deploy)     (flagship-webapp first, then flagship-com; answer YES to the custom-domain prompt; no pipe, no redirect)
curl -sI https://webapp.flagshipserver.com/ ; curl -sI https://remote.flagshipserver.com/    (200 and a strict content-security-policy)
curl -s -o /dev/null -w "%{http_code}" https://webapp.flagshipserver.com/lib/no-such-file.js (404 from the static-only Worker)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/                          (the marketing page, 200)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/api/health
curl -s https://webapp.flagshipserver.com/service-worker.js | grep "^const SHELL_VERSION"     (equals the tree's)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/api/notices        (204 until a notice is signed)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/api/users/<unknown>/pods   (404 account-not-found)
curl -s -o /dev/null -w "%{http_code}" https://boot.flagshipserver.com/not-a-route   (404 from the boot host)
curl -s https://inference.flagshipserver.com/healthz                                 (shim; warning only)
curl -sI https://flagshipserver.com/ | grep -i "x-frame-options\|strict-transport"
npm run zone-health                                                                  (post-check: wildcard + CAA lines must be OK; legacy account records are listed until the reap; admin secret)
EOF
  GATE="webapp. and remote. answer 200 with the strict CSP, the live shell version equals the tree's, / answers, health 200, notices 204, account-not-found 404, boot route 404, framing headers present."
  ROLLBACK="Move of the webapp hosts: put the two custom_domain lines for webapp. and remote. back in the routes array of apps/com/wrangler.toml (git history has them) and deploy flagship-com (answer yes at the prompt). Code: (cd apps/com && wrangler deployments list && wrangler rollback <version-id>), which leaves custom domains and D1 untouched."
}
meta_cpu() {
  TITLE="Watch for exceededCpu (60 s tail while you use the app)"
  RUNBOOK="14. Free vs Paid (Workers plan)"
  WHAT="Tails the live Worker for 60 seconds while you load Trusted devices and the webapp, and fails on any exceededCpu outcome."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && wrangler tail flagship-com --format json)    (60 s, then stopped)
(dashboard) Workers & Pages -> flagship-com -> Metrics: requests per day; alarm at 70,000 (cap 100,000)
EOF
  GATE="Zero exceededCpu events in the 60 s window."
  ROLLBACK="If it fires: upgrade to Workers Paid (USD 5 a month, dashboard) or roll .com back."
}
meta_services() {
  TITLE="Deploy .services (Fly relay)"
  RUNBOOK="8. Deploy \`.services\` (Fly): needed, one image"
  WHAT="Deploys the relay image (the uniform drop timing for unregistered names) FIRST, before the DNS wildcard and before .com, so the relay already drops unknown names uniformly when the wildcard starts answering them. Every box's tunnel drops for about 20 seconds."
  read -r -d '' CMDS <<'EOF' || true
flyctl releases -a flagship-services | head -5
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services
curl -s -o /dev/null -w "%{http_code}" https://flagship.services/api/health
EOF
  GATE="https://flagship.services/api/health answers 200 and https://flagshipserver.com/status/ shows boxes back online within a minute."
  ROLLBACK="flyctl releases rollback -a flagship-services (stateless; clean)."
}
meta_dns() {
  TITLE="Cloudflare DNS by hand: root wildcard + apex CAA (before the .com deploy)"
  RUNBOOK="6a. The one-time manual DNS step: the root wildcard and the apex CAA"
  WHAT="Prints the exact records for you to create in the Cloudflare dashboard (grey cloud) and checks them with dig only. It comes before the .com deploy: the new .com writes no per-box address records, so a box registering while no wildcard exists would get names that do not resolve (and resolvers cache that for 30 minutes). Existing accounts keep answering from their own records."
  read -r -d '' CMDS <<'EOF' || true
flyctl ips list -a flagship-services          (must list SERVICES_PASSTHROUGH_IPV4/6 from apps/com/wrangler.toml)
(dashboard, flagship.services zone, DNS only / grey cloud:)
  A     *   <relay IPv4>        AAAA  *   <relay IPv6>
  CAA   @   issue     letsencrypt.org        CAA  @   issuewild   letsencrypt.org
dig +short A anything-at-all.flagship.services @1.1.1.1
dig +short AAAA anything-at-all.flagship.services @1.1.1.1
dig +short CAA flagship.services @1.1.1.1
EOF
  GATE="The wildcard A and AAAA answer the relay address and the CAA pair is visible (zone-health is not deployed yet; it runs as a post-check of the .com deploy)."
  ROLLBACK="Delete the two wildcard records and the two CAA records. Do not roll back after the reap has trimmed accounts."
}
meta_publish() {
  TITLE="Publish the VM appliances that are ready (amd64 now, arm64 when green)"
  RUNBOOK="9. Publish the VM appliances"
  WHAT="Finds the newest green vm-appliance runs on main built after the endorsement, checks the boot smoke, uploads each arch to R2 and commits the manifests. arm64 may be skipped here and published in phase B."
  read -r -d '' CMDS <<'EOF' || true
gh run list --workflow vm-appliance.yml --branch main --status success
gh api repos/{owner}/{repo}/actions/runs/<id>/artifacts       (arch = artifact name)
gh run view <id> --json jobs                                  (the boot smoke step must be success)
bash scripts/publish-vm-appliance.sh <run id>                 (once per arch; uploads parts to R2 flagship-iso/)
git add -- apps/web/public/downloads/FlagshipVMAppliance-<arch>.json && git commit -m "Publish the rebuilt VM appliances"
git push origin HEAD:main
EOF
  GATE="Each manifest's commit equals the endorsed release; its sha256 is recorded for the status file."
  ROLLBACK="Re-point the manifest at the previous commit and redeploy .com; old R2 parts stay."
}
meta_redeployA() {
  TITLE="Redeploy .com so /downloads/ serves the new manifests"
  RUNBOOK="9. Publish the VM appliances"
  WHAT="Deploys the pinned commit (which now carries the appliance manifests) with 'npm run deploy' and repeats the post-checks, plus the manifest sha256 on the live site."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && npm run deploy)
curl -s https://flagshipserver.com/downloads/FlagshipVMAppliance-<arch>.json | jq .sha256
(the same health, shell, notices, account-not-found, boot probes as the first .com deploy)
EOF
  GATE="The live manifest sha256 equals the published run's."
  ROLLBACK="wrangler rollback <version-id> in apps/com."
}
meta_status() {
  TITLE="Write DEPLOYED-FINAL status for the Windows agent"
  RUNBOOK="9. Publish the VM appliances"
  WHAT="Writes device-results/DEPLOYED-FINAL-<date>.md (main sha, endorsed release, shell version, DNS design, appliances with sha256, what is live), prints it, and on your yes commits it to the device-results branch from a temporary worktree."
  read -r -d '' CMDS <<'EOF' || true
git worktree add --detach <tmp> origin/device-results/windows-2026-10-17
cp DEPLOYED-FINAL-<date>.md <tmp>/device-results/ && git add -- device-results/DEPLOYED-FINAL-<date>.md && git commit
git push origin HEAD:refs/heads/device-results/windows-2026-10-17        (fast-forward only)
EOF
  GATE="The push is a fast-forward of the branch; main is not touched."
  ROLLBACK="Revert the commit on the device-results branch; it is a status note."
}
meta_notice() {
  TITLE="Maintenance notice (preview; you sign it)"
  RUNBOOK="12. The pre-GA scrub, the reap and the maintenance notice"
  WHAT="Previews the maintainer-signed notice people will see before the scrub; you sign it in another terminal (YubiKey), then this step commits it, pushes and redeploys .com."
  read -r -d '' CMDS <<'EOF' || true
node scripts/security-notice.mjs maintenance --message "<text>" --event <ISO time>            (preview: writes nothing)
(you, in another terminal, in the worktree: the same command with --sign)
git add -- .maintainers/notices && git commit -m "Notice: maintenance on <date>" && git push origin HEAD:main
(cd apps/com && npm run deploy)
curl -s https://flagshipserver.com/api/notices
EOF
  GATE="/api/notices returns the notice."
  ROLLBACK="node scripts/security-notice.mjs clear --sign, commit, deploy."
}
meta_scrub() {
  TITLE="Pre-GA scrub of prod D1 (GA go/no-go gate first)"
  RUNBOOK="12. The pre-GA scrub, the reap and the maintenance notice"
  REQUIRED=1
  WHAT="After you confirm the Windows results were reviewed, takes a D1 export, shows the dry run, and runs the wipe tool, which asks you to type the database name itself; then verifies the orphan counts."
  read -r -d '' CMDS <<'EOF' || true
(typed gate: windows-ok, or skip-windows)
(cd apps/com && wrangler d1 export flagship-state --remote --output ~/d1-before-scrub-<ts>.sql)
WIPE_ENV=prod WIPE_D1=flagship-state bash scripts/wipe-all-users.sh --list-accounts
WIPE_ENV=prod WIPE_D1=flagship-state WIPE_CONFIRM=prod bash scripts/wipe-all-users.sh --yes     (asks you to type flagship-state)
(cd apps/com && wrangler d1 execute flagship-state --remote --json --command "SELECT username FROM usernames")
(cd apps/com && wrangler d1 execute flagship-state --remote --json --command "<four orphan counts>")
EOF
  GATE="Only playstore-test-0725 remains; the four orphan counts are 0."
  ROLLBACK="The wipe cannot be undone except from the D1 export taken first (docs/runbooks/d1-restore.md)."
}
meta_reap() {
  TITLE="Reap orphaned DNS records and demo servers, then zone-health"
  RUNBOOK="12. The pre-GA scrub, the reap and the maintenance notice"
  WHAT="Sweeps the gym leftovers (default; refused while the gym lock exists, skippable with a typed answer), dry-runs the reap (saved plan), applies it (the tool asks you to type the counts), re-runs the dry run and zone-health, prints what is left on purpose and why (you type reviewed), then the owner checklist of what no tool can see (you type checked or skipped for each)."
  read -r -d '' CMDS <<'EOF' || true
(typed: sweep, or skip-gym; refused while /private/tmp/claude-501/flagship-locks/gym.lock exists)
npx tsx tools/live-e2e/sweep-cli.ts   then   npx tsx tools/live-e2e/sweep-cli.ts --destroy      (gym leftovers)
node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan.json                 (admin secret; dry run)
node scripts/reap-orphans.mjs --apply --plan ~/pre-ga-reap-plan.json               (types "delete N records and M servers")
node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan-after.json
npm run zone-health
node scripts/reap-orphans.mjs --review --plan ~/pre-ga-reap-plan-after.json         (every kept record and server, with its reason; read-only; type reviewed)
(owner checklist, type checked or skipped for each: UpCloud console, Hetzner, flagshipserver.com Cloudflare zone, R2 buckets, Fly)
EOF
  GATE="The second dry run lists 0 orphaned records and servers; zone-health is OK; you typed reviewed and answered every owner-checklist line."
  ROLLBACK="DNS records need no recreating (the wildcard answers every name); a demo server is recreated from its account. ~/pre-ga-reap-plan.json.log.jsonl lists what went."
}
meta_retire() {
  TITLE="Land chore/delete-wipe-tooling (retire the wipe tool)"
  RUNBOOK="12. The pre-GA scrub, the reap and the maintenance notice"
  WHAT="Rebases the retire branch onto origin/main in the worktree, runs tsc, the scripts tests and the release guard, and on your yes pushes it to main."
  read -r -d '' CMDS <<'EOF' || true
git fetch origin chore/delete-wipe-tooling
git switch -c retire-wipe-tooling origin/chore/delete-wipe-tooling && git rebase origin/main
npx tsc -b && npx vitest run scripts && RELEASE=1 bash scripts/release-guard.sh
git push origin HEAD:main
EOF
  GATE="The push is a fast-forward and release-guard passes without scripts/wipe-all-users*."
  ROLLBACK="git revert the commits on main (history keeps the script)."
}
meta_studiowl() {
  TITLE="Studio for Windows and Linux: public GitHub release + download URLs"
  RUNBOOK="10. Studio releases (Mac, Windows, Linux)"
  WHAT="Dispatches studio-release.yml with publish=true, waits for it, points INSTALLER_DOWNLOADS in apps/com/src/route.ts (and its test) at the new asset names, tests, pushes."
  read -r -d '' CMDS <<'EOF' || true
gh workflow run studio-release.yml --ref main -f publish=true
gh run watch <id> --exit-status
gh release view studio-v<studio version> --json assets
node -e '<rewrite studio-v0.1.3 URLs in apps/com/src/route.ts and apps/com/test/route.test.ts>'
npx vitest run apps/com/test/route.test.ts
git add -- apps/com/src/route.ts apps/com/test/route.test.ts && git commit -m "Point the Windows and Linux Studio downloads at studio-v<version>"
git push origin HEAD:main
EOF
  GATE="The release has the Windows zip and the Linux AppImage; the route test passes on the new names."
  ROLLBACK="Point INSTALLER_DOWNLOADS back at the previous tag and redeploy .com; delete the release with gh release delete if it is wrong."
}
meta_studiomac() {
  TITLE="Studio for Mac: build, sign, notarize, commit the DMG"
  RUNBOOK="10. Studio releases (Mac, Windows, Linux)"
  WHAT="Runs scripts/release-studio.sh (build, sign, notarize with your keychain profile, staple, stage the DMG; it publishes nothing), then commits the DMG and pushes. The .com redeploy is the later step."
  read -r -d '' CMDS <<'EOF' || true
bash scripts/release-studio.sh
spctl -a -vv -t install apps/web/public/downloads/FlagshipStudio.dmg
git add -- apps/web/public/downloads/FlagshipStudio.dmg && git commit -m "Publish a new Flagship Studio build"
git push origin HEAD:main
EOF
  GATE="Notarization accepted; the DMG passes spctl."
  ROLLBACK="git revert the DMG commit and redeploy .com."
}
meta_publisharm() {
  TITLE="Publish the arm64 VM appliance if it is still pending"
  RUNBOOK="9. Publish the VM appliances"
  WHAT="Same as the appliance publish, for arm64 only (the arm64 build runs under TCG and may have finished after phase A)."
  read -r -d '' CMDS <<'EOF' || true
gh run list --workflow vm-appliance.yml --branch main --status success
bash scripts/publish-vm-appliance.sh <arm64 run id>
git add -- apps/web/public/downloads/FlagshipVMAppliance-arm64.json && git commit -m "Publish the rebuilt arm64 VM appliance"
git push origin HEAD:main
EOF
  GATE="The arm64 manifest commit equals the endorsed release."
  ROLLBACK="Re-point the manifest at the previous commit and redeploy .com."
}
meta_redeployB() {
  TITLE="Redeploy .com with everything pushed in phase B"
  RUNBOOK="7. Deploy \`.com\` (two Workers)"
  WHAT="One deploy that carries the notice, the Studio download URLs, the DMG and the arm64 manifest, with the post-checks and the download redirects."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && npm run deploy)
curl -sI https://flagshipserver.com/download/mac ; curl -sI https://flagshipserver.com/download/windows ; curl -sI https://flagshipserver.com/download/linux
(the same health, shell, notices, account-not-found, boot probes)
EOF
  GATE="The three download redirects point at the new assets."
  ROLLBACK="wrangler rollback <version-id> in apps/com."
}
meta_ios() {
  TITLE="iOS: Release-clean scan, archive, upload to App Store Connect"
  RUNBOOK="11. iOS and Android store builds"
  WHAT="Scans a Release build for mocks and gym seams, archives, and (second confirm) exports with a generated app-store-connect ExportOptions.plist that uploads the build."
  read -r -d '' CMDS <<'EOF' || true
node scripts/ios-release-clean.mjs --build
xcodebuild archive -project apps/mobile/ios/App/FlagshipApp.xcodeproj -scheme FlagshipApp -destination generic/platform=iOS -archivePath <tmp>/FlagshipApp.xcarchive -derivedDataPath <tmp>/dd -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath <tmp>/FlagshipApp.xcarchive -exportOptionsPlist <tmp>/ExportOptions.plist -allowProvisioningUpdates      (uploads; burns the build number)
EOF
  GATE="The scan is clean; the upload says 'Upload succeeded'. Then submit in App Store Connect."
  ROLLBACK="A store build cannot be recalled: halt the rollout in App Store Connect and ship a higher build."
}
meta_android() {
  TITLE="Android: release-clean check and the two AABs"
  RUNBOOK="11. iOS and Android store builds"
  WHAT="Builds the release APKs and bundles with the upload key (linked from your checkout, never copied), runs the release-clean check, and copies the AABs to ~/flagship-release-artifacts."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/mobile/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew :app:assembleRelease :wear:assembleRelease :app:bundleRelease :wear:bundleRelease)
(cd apps/mobile/android && bash scripts/check-release-clean.sh)
shasum -a 256 <the two .aab files>
EOF
  GATE="check-release-clean prints ok for app and wear; the AAB versionCode is above Play's highest."
  ROLLBACK="Nothing is uploaded by this step; upload to the Play internal track by hand."
}
meta_final() {
  TITLE="Final verification and the closing summary"
  RUNBOOK="13. What should block GA"
  OUTWARD=0
  WHAT="Re-probes everything that is live, compares the endorsed release with box-code changes on main, and prints the sha, versions, URLs and what is still manual."
  read -r -d '' CMDS <<'EOF' || true
curl health: .com, .services, status page, shell version, notices, downloads, zone-health, schema-status (admin secret)
git diff --stat <endorsed>..<PIN> -- packages/server-daemon installer packages/boot-core
EOF
  GATE="All probes pass."
  ROLLBACK="Per step above."
}

# ---------------------------------------------------------------- listing

show_meta() { # idx [verbose]
  local idx=$1 id; id=$(step_id "$idx")
  TITLE=""; WHAT=""; RUNBOOK=""; CMDS=""; GATE=""; ROLLBACK=""; REQUIRED=0; OUTWARD=1
  "meta_$id"
  local tag="outward"; [ "$OUTWARD" = 1 ] || tag="local/read-only"
  [ "$REQUIRED" = 1 ] && tag="$tag, required"
  printf '%s%02d. %s%s\n' "$C_B" "$idx" "$TITLE" "$C_0"
  printf '    phase %s | %s | runbook: %s\n' "$(step_phase "$idx")" "$tag" "$RUNBOOK"
  if [ "${2:-full}" = full ]; then
    printf '    does:     %s\n' "$WHAT"
    printf '    commands:\n'
    printf '%s\n' "$CMDS" | sed 's/^/      $ /'
    printf '    gate:     %s\n' "$GATE"
    printf '    rollback: %s\n' "$ROLLBACK"
  fi
  echo
}

list_plan() { # mode phase
  local mode=${1:-full} phase=${2:-} i n; n=$(step_count)
  for ((i = 1; i <= n; i++)); do
    if [ -n "$phase" ] && [ "$(step_phase "$i")" != "$phase" ]; then continue; fi
    show_meta "$i" "$mode"
  done
}

# ---------------------------------------------------------------- helpers

X() { # log then run; any failure ends the run (steps rely on this, not on set -e)
  printf '%s+ %s%s\n' "$C_D" "$*" "$C_0"
  "$@" || fail "command failed ($?): $*"
}
XA() { # XA dir cmd...
  local d=$1; shift
  printf '%s+ (cd %s && %s)%s\n' "$C_D" "$d" "$*" "$C_0"
  ( cd "$d" && "$@" ) || fail "command failed ($?): (cd $d && $*)"
}
WX() { XA "$WT" "$@"; }
wt_git() { git -C "$WT" "$@"; }

confirm() { # confirm "question" -> 0 on y
  local a=""
  printf '%s? %s %s[y/N]%s ' "$C_Y" "$1" "$C_B" "$C_0"
  read -r a || a=""
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
ask_word() { # ask_word "prompt" -> echoes the reply
  local a=""
  printf '%s? %s%s ' "$C_Y" "$1" "$C_0" >&2
  read -r a || a=""
  printf '%s' "$a"
}

http_code() { curl -s -o /dev/null -m 25 -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

probe_code() { # label url expected [tries]
  local label=$1 url=$2 want=$3 tries=${4:-4} i code=""
  for ((i = 1; i <= tries; i++)); do
    code=$(http_code "$url")
    [ "$code" = "$want" ] && { ok "$label: $code"; return 0; }
    sleep 4
  done
  err "$label: got $code, want $want ($url)"
  PROBE_FAILS=$((PROBE_FAILS + 1))
  return 0
}
info_code() { local code; code=$(http_code "$2"); say "  info  $1: $code"; }

probe_end() { # after the probes of a step: continue anyway?
  if [ "$PROBE_FAILS" -eq 0 ]; then PROBE_FAILS=0; return 0; fi
  warn "$PROBE_FAILS probe(s) failed."
  PROBE_FAILS=0
  confirm "Treat the step as done anyway? (say no to stop and fix; resume with --from $CURRENT_STEP)" || return 11
  return 0
}

need_admin_secret() {
  [ -n "$ADMIN_SECRET" ] && return 0
  printf '%sFLAGSHIP_ADMIN_SECRET%s (typed silently, kept in memory for this run only; empty = skip): ' "$C_Y" "$C_0" >&2
  read -rs ADMIN_SECRET || ADMIN_SECRET=""
  echo >&2
  [ -n "$ADMIN_SECRET" ]
}
with_secret() { ( FLAGSHIP_ADMIN_SECRET="$ADMIN_SECRET"; export FLAGSHIP_ADMIN_SECRET; "$@" ); }
admin_curl() { # admin_curl url : the header travels on stdin, never in argv
  printf 'header = "x-admin-secret: %s"\n' "$ADMIN_SECRET" | curl -s -m 30 -K - "$1"
}

num_ge() { node -e 'process.exit(Number(process.argv[1])>=Number(process.argv[2])?0:1)' "$1" "$2"; }

free_gb() { df -Pk "${1:-$HOME}" | awk 'NR==2{printf "%d", $4/1048576}'; }

wrangler_cmd() { if command -v wrangler >/dev/null 2>&1; then echo wrangler; else echo "npx wrangler"; fi; }
WR() { # WR args... : wrangler from PATH, else npx (run inside apps/com)
  if command -v wrangler >/dev/null 2>&1; then wrangler "$@"; else npx wrangler "$@"; fi
}
WRX() { # logged, in apps/com of the worktree
  printf '%s+ (cd apps/com && wrangler %s)%s\n' "$C_D" "$*" "$C_0"
  ( cd "$WT/apps/com" && WR "$@" ) || fail "wrangler $* failed"
}
WRQ() { ( cd "$WT/apps/com" && WR "$@" ); } # quiet capture, caller handles failure

json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o=JSON.parse(s);for(const k of process.argv[1].split("."))o=o==null?o:o[k];console.log(o==null?"":o)})' "$1"; }


# ---------------------------------------------------------------- parsers
# Pure functions: each reads the raw output of one external tool on stdin. They are
# tested against real captured outputs (scripts/release-fixtures/).

# wrangler secret list (JSON) -> one secret NAME per line
json_names() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const x of JSON.parse(s))console.log(x.name)}catch{}})'; }

# gh secret list (tab separated: NAME, updated) -> NAME per line
gh_secret_names() { awk -F'\t' 'NF>=1 && $1 != "" {print $1}'; }

# wrangler d1 execute --json of "SELECT version FROM schema_version" + a migrations dir -> pending files
pending_migrations() { # $1 = migrations dir
  node -e '
const fs=require("fs"),dir=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const p=JSON.parse(s);const have=new Set((Array.isArray(p)?p:[p]).flatMap(r=>r.results||[]).map(r=>String(r.version)));
for(const f of fs.readdirSync(dir).filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort())if(!have.has(f.slice(0,4)))console.log(f)})' "$1"
}

# gh run list --json databaseId,status,conclusion,headSha,createdAt -> ids of completed+successful runs created at/after $1 (ISO, may be empty), newest first
runs_after() {
  node -e '
const after=process.argv[1]?Date.parse(process.argv[1]):0;let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const runs=JSON.parse(s).filter(r=>r.status==="completed"&&r.conclusion==="success"&&Date.parse(r.createdAt)>=after);
runs.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));for(const r of runs)console.log(r.databaseId)})' "${1:-}"
}

# gh api .../runs/<id>/artifacts -> exit 0 when it holds a live vm-appliance-<arch> artifact
artifacts_have() { # $1 = arch
  node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const a=(JSON.parse(s).artifacts||[]).some(x=>x.name==="vm-appliance-"+process.argv[1]&&!x.expired);process.exit(a?0:1)})' "$1"
}

# gh run view <id> --json jobs -> the conclusion of the boot-smoke step ("success", "failure", "" when absent)
smoke_state() {
  node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const c=(JSON.parse(s).jobs||[]).flatMap(j=>j.steps||[]).filter(x=>/boot smoke/i.test(x.name)).map(x=>x.conclusion||x.status);
console.log(c.length&&c.every(x=>x==="success")?"success":(c[0]||""))})'
}

# flyctl ips list output on stdin; $1 = v4, $2 = v6 (may be empty) -> exit 0 when both are listed
ips_agree() { local t; t=$(cat); echo "$t" | grep -qF "$1" && { [ -z "${2:-}" ] || echo "$t" | grep -qF "$2"; }; }

# .maintainers/backup-recipient.pub on stdin -> exit 0 when it holds a real age public key (not the placeholder)
age_recipient_ok() {
  local k; k=$(grep -v '^[[:space:]]*#' | sed '/^[[:space:]]*$/d' | head -1 | tr -d '[:space:]')
  [[ "$k" =~ ^age1[0-9a-z]{50,}$ ]]
}

# gh run list --json databaseId,createdAt (any status) + ISO time $1 -> id of the newest run created at/after it
newest_run_since() {
  node -e '
const t=Date.parse(process.argv[1]);let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const r=JSON.parse(s).filter(x=>Date.parse(x.createdAt)>=t).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
if(r)console.log(r.databaseId)})' "$1"
}

# latest.json of the D1 backup on stdin, $1 = max age in minutes -> prints a summary, exit 0 when fresh with tables and a d1/ key
latest_json_ok() {
  node -e '
const max=Number(process.argv[1]);let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
let j;try{j=JSON.parse(s)}catch{console.log("not JSON");process.exit(1)}
const age=(Date.now()-Date.parse(j.takenAt))/60000;
console.log(`takenAt ${j.takenAt} (${Math.round(age)} min ago), tables ${j.tables}, key ${j.key}`);
process.exit(age>=0&&age<=max&&Number(j.tables)>0&&/^d1\//.test(String(j.key))?0:1)})' "$1"
}

# file names on stdin -> the ones under a box path
box_files_in() {
  local f p keep
  while IFS= read -r f; do
    keep=0
    for p in "${BOX_PATHS[@]}"; do case "$f" in "$p"|"$p"/*) keep=1 ;; esac; done
    if [ "$keep" = 1 ]; then echo "$f"; fi
  done
}

# file names on stdin -> vitest filters for the packages they touch (scripts and apps/com always)
test_filters_from_names() {
  { echo scripts; echo apps/com
    sed -n 's#^\(packages/[^/]*\)/.*#\1#p;s#^\(apps/[^/]*\)/.*#\1#p;s#^\(billing\)/.*#\1#p;s#^\(infra\)/.*#\1#p;s#^\(tools\)/.*#\1#p'
  } | sort -u | tr '\n' ' '
}

# ---------------------------------------------------------------- pin and worktree

git_fetch_main() { git -C "$REPO" fetch -q origin main; }
origin_main() { git -C "$REPO" rev-parse --verify -q origin/main 2>/dev/null || git -C "$REPO" rev-parse HEAD; }
short() { echo "${1:0:8}"; }

wt_exists() { [ -e "$WT/.git" ]; }

link_local_files() { # link_local_files file...  (relative to the repo root; only gitignored local config)
  local f
  for f in "$@"; do
    if [ -e "$MAIN_CHECKOUT/$f" ] && [ ! -e "$WT/$f" ]; then
      mkdir -p "$(dirname "$WT/$f")"
      ln -s "$MAIN_CHECKOUT/$f" "$WT/$f"
    fi
  done
}
unlink_local_files() { local f; for f in "$@"; do if [ -L "$WT/$f" ]; then rm -f "$WT/$f"; fi; done; }

ensure_wt() {
  local free; free=$(free_gb "$HOME")
  [ "$free" -ge 5 ] || fail "only ${free} GB free: the disk needs more than 5 GB before a build"
  mkdir -p "$RELEASE_HOME"
  if ! wt_exists; then
    git -C "$REPO" worktree prune
    case "$WT" in "$RELEASE_HOME"/*) rm -rf "$WT" ;; *) fail "refusing to remove $WT" ;; esac
    X git -C "$REPO" worktree add --detach "$WT" "$PIN"
    XA "$WT" npm ci
    XA "$WT" npx tsc -b
    return 0
  fi
  local head; head=$(wt_git rev-parse HEAD)
  if [ "$head" != "$PIN" ]; then
    local lock_old lock_new
    lock_old=$(wt_git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)
    X git -C "$WT" checkout -q --detach "$PIN"
    lock_new=$(wt_git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)
    [ "$lock_old" = "$lock_new" ] || XA "$WT" npm ci
    XA "$WT" npx tsc -b
  fi
}

set_pin() { PIN=$1; st_w set pinned "$PIN"; }

pin_guard() { # stop (or re-pin) when origin/main is not the pinned commit
  [ "$DRY" = 1 ] && return 0
  git_fetch_main || { warn "could not fetch origin"; return 0; }
  local cur; cur=$(origin_main)
  [ "$cur" = "$PIN" ] && return 0
  hdr "origin/main moved"
  say "pinned:      $PIN"
  say "origin/main: $cur"
  git -C "$REPO" log --oneline --no-decorate "$PIN..$cur" 2>/dev/null | head -25 | sed 's/^/  /'
  if ! git -C "$REPO" merge-base --is-ancestor "$PIN" "$cur" 2>/dev/null; then
    warn "origin/main is not a descendant of the pinned commit (history was rewritten?)."
  fi
  say "Other people landed commits while the release runs. Re-pinning means the rest of the"
  say "release deploys those commits too (untested by the gym run above this point)."
  if confirm "Re-pin to $(short "$cur") and continue?"; then
    set_pin "$cur"
    st_w add repins "$cur"
    if wt_exists; then
      local lock_old lock_new
      lock_old=$(wt_git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)
      wt_git checkout -q --detach "$PIN"
      lock_new=$(wt_git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)
      [ "$lock_old" = "$lock_new" ] || XA "$WT" npm ci
      XA "$WT" npx tsc -b
    fi
    return 0
  fi
  fail "stopped: origin/main moved. Re-run to re-pin, or land nothing until the release is done."
}

commit_paths() { # commit_paths "message" path...
  local msg=$1; shift
  say "  changes to be committed:"; wt_git status --short -- "$@" | sed 's/^/    /'
  X git -C "$WT" add -- "$@"
  X git -C "$WT" commit -q -m "$msg" -- "$@"
}

land_commits() { # push the worktree HEAD to main (fast-forward only) and re-pin to it
  git -C "$WT" fetch -q origin main
  if ! wt_git merge-base --is-ancestor origin/main HEAD; then
    fail "origin/main moved since the pin: nothing was pushed. Run again to re-pin (your commit stays in the worktree only until the script exits)."
  fi
  say "  to be pushed to origin main:"; wt_git log --oneline --no-decorate origin/main..HEAD | sed 's/^/    /'
  confirm "Push these commits to origin main now (git push origin HEAD:main)?" || return 10
  X git -C "$WT" push origin HEAD:main
  set_pin "$(wt_git rev-parse HEAD)"
  st_w add pushed "$PIN"
  git_fetch_main || true
  ok "pushed; the release is now pinned to $(short "$PIN")"
}

latest_endorsed() { # prints the newest endorsed commit, or nothing
  local e; e=$( ( cd "$WT" && node scripts/latest-endorsed-release.mjs ) 2>/dev/null | tail -1 || true)
  if [[ "$e" =~ ^[0-9a-f]{40}$ ]]; then echo "$e"; fi
}

BOX_PATHS=(packages/server-daemon installer packages/boot-core packages/protocol packages/tunnel-protocol packages/llm-providers package.json package-lock.json)

with_maintainers() { # run a command with the maintainers clone linked into the worktree
  [ -d "$MAIN_CHECKOUT/maintainers/packages/cli" ] || fail "the maintainers clone is missing at $MAIN_CHECKOUT/maintainers"
  ln -s "$MAIN_CHECKOUT/maintainers" "$WT/maintainers"
  local rc=0
  "$@" || rc=$?
  rm -f "$WT/maintainers"
  return $rc
}

require_done() { # require_done id...  (warn and ask when a step this one depends on is not recorded)
  local id idx
  for id in "$@"; do
    idx=$(step_index "$id")
    if ! st_has done "$idx"; then
      warn "step $idx ($id) is not recorded as done."
      confirm "Continue anyway?" || return 10
    fi
  done
}
step_index() { local i n; n=$(step_count); for ((i = 1; i <= n; i++)); do [ "$(step_id "$i")" = "$1" ] && { echo "$i"; return; }; done; echo 0; }

shell_version() { # shell_version dir -> number
  sed -n 's/^const SHELL_VERSION *= *"\(v[0-9]*\)".*/\1/p' "$1/apps/web/public/webapp/service-worker.js" | head -1
}
live_shell_version() {
  curl -s -m 25 "$WEBAPP_URL/service-worker.js" | sed -n 's/^const SHELL_VERSION *= *"\(v[0-9]*\)".*/\1/p' | head -1
}

com_checks() {
  PROBE_FAILS=0
  hdr "Post-deploy checks for .com"
  probe_code "health" "$COM_URL/api/health" 200
  local want got i; want=$(shell_version "$WT")
  for i in 1 2 3 4 5 6; do got=$(live_shell_version); [ "$got" = "$want" ] && break; sleep 5; done
  if [ "$got" = "$want" ] && [ -n "$want" ]; then ok "webapp shell version $got equals the tree's"; else err "webapp shell version live '$got', tree '$want'"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  local host code csp
  for host in "$WEBAPP_URL" "$REMOTE_URL"; do
    code=$(http_code "$host/")
    csp=$(curl -sI -m 25 "$host/" | tr -d '\r' | grep -i '^content-security-policy:' | head -1 || true)
    if [ "$code" = 200 ] && echo "$csp" | grep -q "script-src 'self'"; then ok "$host/ answers 200 with the strict shell CSP"
    else err "$host/ answered $code, CSP '${csp:-none}' (want 200 and script-src 'self')"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  done
  probe_code "the static-only Worker's 404 for an unknown file" "$WEBAPP_URL/lib/no-such-file.js" 404
  probe_code "marketing page" "$COM_URL/" 200
  local n; n=$(http_code "$COM_URL/api/notices")
  if [ "$n" = 204 ]; then ok "notices: 204 (none signed)"; elif [ "$n" = 200 ]; then ok "notices: 200 (a notice is published)"; else err "notices: $n"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  probe_code "account-not-found" "$COM_URL/api/users/zz-no-such-account-release-probe/pods" 404
  probe_code "boot host answers (404 for an unknown path)" "$BOOT_URL/not-a-route" 404
  info_code "inference shim /healthz" "$SHIM_URL/healthz"
  if curl -sI -m 25 "$COM_URL/" | grep -qi '^x-frame-options: *deny' && curl -sI -m 25 "$COM_URL/" | grep -qi '^strict-transport-security'; then
    ok "framing and HSTS headers present"
  else err "framing / HSTS headers missing on $COM_URL/"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  info_code "status page" "$COM_URL/status/"
  if [ "${1:-}" = zone ]; then
    if need_admin_secret; then
      say "  zone-health (the wildcard and CAA lines must be OK; legacy per-account records are still listed until the reap):"
      with_secret bash -c "cd '$WT' && npm run -s zone-health" || warn "zone-health exited non-zero (expected while legacy account records remain)"
      [ "$(ask_word "Are the wildcard and CAA lines OK? (y/n)")" = y ] || PROBE_FAILS=$((PROBE_FAILS + 1))
    fi
  fi
  probe_end
}

com_deploy() { # deploy the pinned commit from the worktree
  ensure_wt
  [ -z "$(wt_git status --porcelain --untracked-files=no)" ] || fail "the worktree has uncommitted changes"
  [ "$(wt_git rev-parse HEAD)" = "$PIN" ] || fail "the worktree is not at the pinned commit"
  say "  deploying $(short "$PIN") (shell $(shell_version "$WT"))"
  say "  current deployments (the rollback target is the previous one):"
  ( cd "$WT/apps/com" && WR deployments list 2>&1 | tail -14 ) | sed 's/^/    /' || true
  cat <<'EOF'

  'npm run deploy' now deploys TWO Workers: the static-only flagship-webapp first, then flagship-com.
  The FIRST run moves the webapp. and remote. custom domains from flagship-com to flagship-webapp, and
  wrangler will ask "Custom Domains already exist for these domains ... Update them to point to this
  script instead?": answer YES. It runs in the foreground of this terminal (nothing is piped), so the
  prompt reaches you. If you answer no, the hostnames stay on flagship-com and the webapp keeps working
  from the old Worker; rerun the step to be asked again.
EOF
  confirm "Deploy .com now ('npm run deploy' in apps/com)?" || return 10
  XA "$WT/apps/com" npm run deploy
  st_w set comDeployedSha "$PIN"
  st_w set shellVersion "$(shell_version "$WT")"
}

# ---------------------------------------------------------------- steps

run_preflight() {
  hdr "Tools"
  local t v miss=0
  for t in git gh node npm npx curl jq wrangler flyctl xcodebuild java dig; do
    if command -v "$t" >/dev/null 2>&1; then
      case "$t" in
        java) v=$(java -version 2>&1 | head -1) ;;
        xcodebuild) v=$(xcodebuild -version 2>&1 | head -1) ;;
        dig) v=$(dig -v 2>&1 | head -1) ;;
        *) v=$("$t" --version 2>&1 | head -1) ;;
      esac
      ok "$t: $v"
    else
      case "$t" in
        git|gh|node|npm|npx|curl|jq) err "$t is missing (needed)"; miss=1 ;;
        *) warn "$t is missing (needed by a later step)" ;;
      esac
    fi
  done
  [ "$miss" = 0 ] || fail "install the missing tools and run again"
  hdr "Logins (each prints who you are; nothing is stored)"
  X gh auth status
  ( WR whoami 2>&1 | sed 's/^/    /' ) || fail "wrangler is not logged in (wrangler login)"
  X flyctl auth whoami
  hdr "Disk"
  ok "$(free_gb "$HOME") GB free (need more than 5)"
  [ "$(free_gb "$HOME")" -ge 5 ] || fail "free some disk first"
  hdr "Pinned commit"
  git -C "$REPO" log -1 --format='  %h %cI %s' "$PIN"
  ensure_wt
  hdr "Gates on the pinned commit"
  WX node scripts/check-versions.mjs
  WX npm run parity
  XA "$WT" env RELEASE=1 bash scripts/release-guard.sh
  local E touched mode
  E=$(latest_endorsed)
  say "  newest endorsed release: ${E:-unknown}"
  mode=$(ask_word "Tests: [q]uick (touched packages), [f]ull (npx vitest run), [n]one? (default q)")
  case "$mode" in
    f|F|full) WX npx vitest run ;;
    n|N|none) warn "tests skipped" ;;
    *)
      touched=$(touched_test_filters "$E")
      # shellcheck disable=SC2086
      WX npx vitest run $touched ;;
  esac
}
touched_test_filters() { # a vitest filter list from the files changed since the newest endorsement
  local e=$1 names=""
  if [ -n "$e" ]; then names=$(wt_git diff --name-only "$e" "$PIN" 2>/dev/null || true); fi
  echo "$names" | test_filters_from_names
}

run_plan() {
  say "  .com runs on the Workers Free plan today (owner, 2026-10-18): 10 ms CPU a request, 100,000"
  say "  requests a day (about 75 always-on accounts), 50 subrequests a request. The 6-hourly D1 backup"
  say "  made 89 D1 calls and does not run on Free: step 8 moves it to GitHub Actions."
  say "  Upgrade to Paid (USD 5 a month) if wrangler tail shows exceededCpu, or the dashboard shows"
  say "  more than 70,000 requests in a day (Workers & Pages -> flagship-com -> Metrics)."
  say "  The flagship.services 200-record zone cap is removed by the root wildcard (step 13)."
  local a; a=$(ask_word "Which plan is flagship-com on? type: free or paid")
  case "$a" in free|paid) st_w set workersPlan "$a"; ok "recorded: $a" ;; *) fail "type free or paid" ;; esac
}

lease_days() { # prints "<days> <notAfter> <caPubkey>" for the lease that runs farthest
  node -e '
const b=require(process.argv[1]);
const l=b.filter(e=>e.kind==="CaEndorsement").sort((a,c)=>Date.parse(c.notAfter)-Date.parse(a.notAfter))[0];
console.log(Math.floor((Date.parse(l.notAfter)-Date.now())/86400000), l.notAfter, l.caPubkey)' "$WT/.maintainers/ca-endorsements/bundle.json"
}
regen_bundle() {
  XA "$WT" node -e 'const fs=require("fs"),p=".maintainers/ca-endorsements";
const a=fs.readdirSync(p).filter(f=>f.endsWith(".json")&&f!=="bundle.json").sort().map(f=>JSON.parse(fs.readFileSync(p+"/"+f,"utf8"))).filter(e=>e&&e.kind==="CaEndorsement");
fs.writeFileSync(p+"/bundle.json",JSON.stringify(a,null,2)+"\n")'
}
run_lease() {
  ensure_wt
  local days na pk
  read -r days na pk < <(lease_days)
  say "  the live lease ends $na ($days days from now); CA pubkey $pk"
  if [ "$days" -lt 0 ]; then err "THE LEASE HAS EXPIRED: every CA-chain check fails closed"; elif [ "$days" -lt 30 ]; then warn "less than 30 days of runway: renew now"; fi
  XA "$WT" node scripts/rotate-ca.mjs status || warn "rotate-ca status could not reach the live site"
  local dflt=n; [ "$days" -lt 45 ] && dflt=y
  say "  (the runbook says renew before anything that needs the CA, so the deploy bundles a lease with runway)"
  local a; a=$(ask_word "Renew the lease now? [y/n] (default $dflt)")
  a=${a:-$dflt}
  case "$a" in y|Y) ;; *) ok "not renewing; $days days of runway remain"; return 0 ;; esac
  local dur; dur=$(ask_word "Lease duration (default 30d)"); dur=${dur:-30d}
  local cli="$MAIN_CHECKOUT/maintainers/packages/cli/bin/maintainers"
  say "  Preview (no signature, nothing written):"
  with_maintainers XA "$WT" node "$cli" ca-endorsement --ca-pubkey "$pk" --scope flagship/directory-attestation --duration "$dur" --track ca --signing-key yubikey-piv:slot=9c --path "$WT/.maintainers" --dry-run
  say "  Confirm the CA pubkey above is the one 'rotate-ca status' shows as served."
  confirm "Sign it now? (YubiKey PIN and touch; the tool asks you to type CA-LEASE)" || return 10
  with_maintainers XA "$WT" node "$cli" ca-endorsement --ca-pubkey "$pk" --scope flagship/directory-attestation --duration "$dur" --track ca --signing-key yubikey-piv:slot=9c --path "$WT/.maintainers"
  regen_bundle
  XA "$WT" node scripts/rotate-ca.mjs status
  read -r days na pk < <(lease_days)
  say "  the lease now ends $na ($days days)"
  commit_paths "Renew the production CA lease" .maintainers/ca-endorsements
  land_commits || return $?
}

run_endorse() {
  ensure_wt
  local E; E=$(latest_endorsed)
  [ -n "$E" ] || warn "could not read the newest endorsed release (needs a built tree and full history)"
  say "  newest endorsed release: ${E:-unknown}"
  say "  box code changed since then (git diff --stat, box paths):"
  if [ -n "$E" ]; then
    wt_git diff --stat "$E" "$PIN" -- "${BOX_PATHS[@]}" | tail -25 | sed 's/^/    /'
    if [ -z "$(wt_git diff --name-only "$E" "$PIN" | box_files_in)" ]; then
      warn "no box path changed since $E. The endorsement is still offered (tests and vectors may count, and the appliances bake the newest endorsed release)."
    else
      warn "BOX CODE CHANGED: this release needs a new endorsement."
    fi
  fi
  local from="${E:-$PIN}"
  say "  Preview (no signature, no write):"
  with_maintainers XA "$WT" node scripts/endorse-release.mjs --to "$PIN" --from "$from" || true
  confirm "Sign the endorsement of $(short "$PIN") now? (YubiKey PIN and touch)" || return 10
  with_maintainers XA "$WT" node scripts/endorse-release.mjs --to "$PIN" --from "$from" --sign
  local endorsed=$PIN
  commit_paths "Endorse $(short "$endorsed") on the ca track" .maintainers/endorsements
  land_commits || return $?
  st_w set endorsed "$endorsed"
  st_w set endorsedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local now; now=$(latest_endorsed)
  if [ "$now" = "$endorsed" ]; then ok "latest-endorsed-release prints $(short "$now")"; else warn "latest-endorsed-release prints '${now:-nothing}', expected $(short "$endorsed")"; fi
}

run_kickoff() {
  [ -n "$(st_get endorsed)" ] || warn "no endorsement is recorded in this run: the appliances bake the newest endorsed release, so a build started before the endorsement is stale"
  XA "$REPO" gh run list --workflow vm-appliance.yml --limit 4
  confirm "Dispatch the amd64 and arm64 appliance builds on main now?" || return 10
  XA "$REPO" gh workflow run vm-appliance.yml --ref main -f arch=amd64 -f git_ref=main -f release=latest-endorsed
  XA "$REPO" gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=latest-endorsed
  st_w set applianceDispatchedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sleep 6
  XA "$REPO" gh run list --workflow vm-appliance.yml --limit 4
  say "  amd64 takes about an hour, arm64 (TCG) up to three. Step 14 collects them."
}

KNOWN_SECRETS=(ACCOUNT_READ_TOKEN_SECRET PB_TOKEN_RSA_JWK PB_FILLER_SECRET PB_TAG_SECRET FLAGSHIP_INFERENCE_TOKEN_SECRET FLAGSHIP_INFERENCE_ENDPOINT)
run_secrets() {
  ensure_wt
  local prod gym
  prod=$(WRQ secret list 2>/dev/null | json_names || true)
  gym=$(WRQ secret list --config wrangler.gym.toml 2>/dev/null | json_names || true)
  [ -n "$prod" ] || fail "could not list the prod secrets (wrangler login?)"
  say "  prod has $(echo "$prod" | wc -l | tr -d ' ') secret names; the gym has $(echo "$gym" | grep -c . || true)"
  local n missing=0
  say "  on the gym but not on prod:"
  for n in $gym; do echo "$prod" | grep -qx "$n" || { say "    $n"; }; done
  say "  names the runbook ties to recent work:"
  for n in "${KNOWN_SECRETS[@]}"; do
    if echo "$prod" | grep -qx "$n"; then ok "$n is set on prod"; else warn "$n is NOT on prod (create: cd apps/com && wrangler secret put $n)"; missing=1; fi
  done
  if [ "$missing" = 1 ]; then confirm "Some names are missing on prod. Continue anyway?" || return 10; fi
}

run_gym() {
  cat <<'EOF'
  The root-wildcard change rewrites how every account's names resolve and how every
  certificate is issued, so it is proven live on the GYM before prod. This script
  cannot check that. In ANOTHER terminal, from the shared checkout, with no other live
  run in progress (the gym and prod share the Let's Encrypt budget of 50 a week):

      bash scripts/gym-refresh.sh
      npx tsx tools/live-e2e/shared-run.ts
      npx tsx tools/live-e2e/dns-ent-experiment.ts --canary

  GO needs ALL of:
    [ ] the core group is all green: zero records for the account, an unregistered name
        closes after the fixed wait, the box gets its Let's Encrypt certificate and
        serves HTTPS 200
    [ ] the recorded DNS shows no gap: the box name and a label under it never answered
        NODATA or NXDOMAIN during issuance
    [ ] the canary exits 0 today (Cloudflare still keeps the wildcard under a TXT)
    [ ] the run was on the commit you are about to deploy (or only .maintainers differs)
    [ ] https://gym.flagshipserver.com/api/health and
        https://flagship-services-gym.fly.dev:8443/api/health answer 200
  NO-GO (any red, a missing certificate, a dark name): do not deploy; fix on main,
  gym-refresh, run again.

  NOT COVERED BY THE GYM: the static-only webapp Worker (flagship-webapp, apps/webapp-static)
  that now serves webapp. and remote.flagshipserver.com. The gym Worker still serves the
  webapp itself, so the .com deploy's post-checks (step 12) are the FIRST real test of that
  path: the custom-domain move, the strict CSP from _headers, the 404 for unknown files.
  Stay at the terminal for that deploy.
EOF
  say "  pinned commit: $(short "$PIN")"
  local a; a=$(ask_word "Type the word  verified  once every box above is true")
  [ "$a" = verified ] || fail "gate not passed (you typed '$a')"
  st_w set gymVerifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  st_w set gymVerifiedSha "$PIN"
}

dispatch_and_wait() { # dispatch_and_wait workflow.yml  -> 0 when the run it started is green
  local wf=$1 t0 id i
  t0=$(date -u -v-30S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-30 seconds' +%Y-%m-%dT%H:%M:%SZ)
  XA "$WT" gh workflow run "$wf" --ref main
  for i in 1 2 3 4 5 6; do
    sleep 6
    id=$( (cd "$WT" && gh run list --workflow "$wf" --event workflow_dispatch --json databaseId,createdAt --limit 5 2>/dev/null) | newest_run_since "$t0" || true)
    [ -n "$id" ] && break
  done
  [ -n "$id" ] || fail "could not find the run that $wf started"
  XA "$WT" gh run watch "$id" --exit-status
}

run_backup() {
  ensure_wt
  local wf
  for wf in d1-backup.yml model-capabilities.yml; do
    [ -f "$WT/.github/workflows/$wf" ] || fail ".github/workflows/$wf is not on the pinned commit: this release cannot back up D1 (the .com deploy removes the Worker's own backup)"
  done
  local bad=0 names s
  names=$( (cd "$WT" && gh secret list 2>/dev/null) | gh_secret_names || true)
  for s in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    if echo "$names" | grep -qx "$s"; then ok "repo secret $s exists"; else err "repo secret $s is missing (repo Settings > Secrets and variables > Actions; runbook step 1b.2-3: a token with D1 Edit + Workers R2 Storage Edit only)"; bad=1; fi
  done
  if age_recipient_ok < "$WT/.maintainers/backup-recipient.pub"; then ok ".maintainers/backup-recipient.pub holds a real age public key"
  else err ".maintainers/backup-recipient.pub is still the placeholder (runbook step 1b.4: age-keygen offline, commit the single age1... line to main, then re-run with a new pin)"; bad=1; fi
  [ "$bad" = 0 ] || return 11
  if WRQ r2 bucket list 2>/dev/null | grep -q 'flagship-d1-backups'; then ok "R2 bucket flagship-d1-backups exists"
  else
    warn "R2 bucket flagship-d1-backups does not exist"
    confirm "Create it (private, no public access) with the 30 day rule on d1/daily/?" || return 10
    WRX r2 bucket create flagship-d1-backups
    WRX r2 bucket lifecycle add flagship-d1-backups expire-daily d1/daily/ --expire-days 30
  fi
  local rules; rules=$(WRQ r2 bucket lifecycle list flagship-d1-backups 2>&1 || true)
  echo "$rules" | sed 's/^/    /'
  if echo "$rules" | grep -q 'd1/daily/'; then ok "a lifecycle rule covers d1/daily/"
  else
    warn "no lifecycle rule on d1/daily/ was found in that output"
    if confirm "Add the rule (expire-daily, d1/daily/, 30 days)?"; then WRX r2 bucket lifecycle add flagship-d1-backups expire-daily d1/daily/ --expire-days 30; else return 11; fi
  fi
  say "  This runs the backup workflow on GitHub (exports prod D1, age-encrypts, uploads to R2) and the model capability refresh once."
  confirm "Run d1-backup.yml now?" || return 10
  dispatch_and_wait d1-backup.yml
  local tmp; tmp=$(mktemp "$RELEASE_HOME/latest.XXXXXX")
  ( cd "$WT/apps/com" && WR r2 object get flagship-d1-backups/latest.json --file "$tmp" --remote >/dev/null 2>&1 ) || { rm -f "$tmp"; fail "could not read flagship-d1-backups/latest.json"; }
  if latest_json_ok 15 < "$tmp" | sed 's/^/    /'; then :; fi
  if latest_json_ok 15 < "$tmp" >/dev/null; then ok "latest.json is fresh with a key under d1/daily/"; else rm -f "$tmp"; fail "latest.json is stale or malformed: the backup did not land"; fi
  rm -f "$tmp"
  confirm "Run model-capabilities.yml once (about 350 model rows into D1)?" || return 10
  dispatch_and_wait model-capabilities.yml
  st_w set d1BackupAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ok "backup prerequisites done: the .com deploy may now remove the Worker's own backup"
}

run_migrations() {
  ensure_wt
  local json; json=$(WRQ d1 execute flagship-state --remote --json --command "SELECT version FROM schema_version ORDER BY version" 2>/dev/null || true)
  [ -n "$json" ] || fail "could not read the prod ledger (wrangler login?)"
  local pending
  pending=$(printf '%s' "$json" | pending_migrations "$WT/packages/storage/migrations")
  if [ -z "$pending" ]; then ok "nothing is pending: every migration file is in the prod ledger"; return 0; fi
  warn "pending migrations:"; echo "$pending" | sed 's/^/    /'
  say "  Make sure the backup of step 8 is fresh: a migration cannot be undone."
  local f ver
  for f in $pending; do
    ver=${f:0:4}
    say "  ---- $f (header) ----"; sed -n '1,14p' "$WT/packages/storage/migrations/$f" | sed 's/^/    /'
    grep -qi 'ADD COLUMN' "$WT/packages/storage/migrations/$f" && warn "contains ADD COLUMN: apply-once, running it twice aborts"
    confirm "Apply $f to PROD D1 and stamp version $ver?" || return 10
    WRX d1 execute flagship-state --remote --file="../../packages/storage/migrations/$f"
    WRX d1 execute flagship-state --remote --command "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES ('$ver', $(date +%s)000)"
  done
  json=$(WRQ d1 execute flagship-state --remote --json --command "SELECT version FROM schema_version" 2>/dev/null || true)
  for f in $pending; do printf '%s' "$json" | grep -q "\"${f:0:4}\"" && ok "ledger has ${f:0:4}" || fail "ledger is missing ${f:0:4} after the apply"; done
}

run_com() {
  require_gym_gate || return $?
  require_done migrations services dns || return 10
  if ! st_has done "$(step_index backup)" && [ -z "$(st_get d1BackupAt)" ]; then
    err "the D1 backup prerequisites (step $(step_index backup)) are not recorded. This deploy REMOVES the Worker's own D1 backup: without them there is no backup at all (Time Travel's 7 days is the only net)."
    [ "$(ask_word "Type  no-backup-accepted  to deploy anyway, or press Enter to stop")" = no-backup-accepted ] || return 10
    st_w set noBackupAccepted "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  com_deploy || return $?
  com_checks zone
}
require_gym_gate() {
  st_has done "$(step_index gym)" || fail "the gym gate (step $(step_index gym)) is not recorded: nothing deploys to prod until it passes"
  local gs; gs=$(st_get gymVerifiedSha)
  if [ -n "$gs" ] && [ "$gs" != "$PIN" ]; then
    if wt_exists || [ "$DRY" = 0 ]; then
      local diff; diff=$(git -C "$REPO" diff --name-only "$gs" "$PIN" 2>/dev/null | grep -v '^\.maintainers/' | head -5 || true)
      if [ -n "$diff" ]; then
        warn "the gym was verified on $(short "$gs"), not on $(short "$PIN"); files that differ outside .maintainers:"
        echo "$diff" | sed 's/^/    /'
        confirm "Deploy anyway?" || return 10
      fi
    fi
  fi
}

run_cpu() {
  ensure_wt
  cat <<'EOF'
  For 60 seconds the live Worker is tailed. Meanwhile, in the app or at
  https://webapp.flagshipserver.com/ : sign in, open Trusted devices, the server list and one
  server page, so the heavy routes run. Any "exceededCpu" outcome fails this step.
EOF
  confirm "Start the 60 second tail now?" || return 10
  local out; out=$(mktemp "$RELEASE_HOME/tail.XXXXXX")
  ( cd "$WT/apps/com" && WR tail flagship-com --format json >"$out" 2>&1 ) &
  local pid=$! i
  for ((i = 60; i > 0; i--)); do printf '\r  tailing... %2ds left ' "$i"; sleep 1; done; echo
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  local total cpu
  total=$(grep -c '"outcome"' "$out" || true)
  cpu=$(grep -Ec '"outcome": *"exceededCpu"' "$out" || true)
  rm -f "$out"
  say "  events seen: $total, exceededCpu: $cpu"
  if [ "$cpu" -gt 0 ]; then
    err "exceededCpu fired $cpu time(s): the 10 ms Free limit is being hit"
    say "  Upgrade to Workers Paid (dashboard -> Workers & Pages -> Plans) or roll .com back."
    return 11
  fi
  [ "$total" -gt 0 ] || warn "no events were seen: nobody used the app during the window; the check proved nothing. Run this step again."
  say "  Requests per day: dashboard -> Workers & Pages -> flagship-com -> Metrics. Alarm at 70,000 (cap 100,000)."
}

run_services() {
  require_gym_gate || return $?
  require_done migrations || return 10
  ensure_wt
  say "  recent Fly releases:"; flyctl releases -a flagship-services 2>&1 | head -5 | sed 's/^/    /' || true
  say "  last relay-path commit on the pin:"; wt_git log -1 --format='    %h %cI %s' -- apps/web/src packages Dockerfile fly.toml billing
  warn "--strategy=immediate drops EVERY box's tunnel for about 20 seconds. Do it when nobody is mid-unlock."
  confirm "Deploy .services to Fly now?" || return 10
  XA "$WT" flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services
  PROBE_FAILS=0
  probe_code ".services health" "$SERVICES_URL/api/health" 200 8
  info_code "status page" "$COM_URL/status/"
  say "  watch $COM_URL/status/ until every box is back online (about a minute)."
  probe_end
}

relay_ips() { # prints "<v4> <v6>" from apps/com/wrangler.toml
  local v4 v6
  v4=$(sed -n 's/^SERVICES_PASSTHROUGH_IPV4 *= *"\(.*\)"/\1/p' "$WT/apps/com/wrangler.toml" | head -1)
  v6=$(sed -n 's/^SERVICES_PASSTHROUGH_IPV6 *= *"\(.*\)"/\1/p' "$WT/apps/com/wrangler.toml" | head -1)
  echo "$v4 $v6"
}
run_dns() {
  require_done services || return 10
  ensure_wt
  local v4 v6; read -r v4 v6 < <(relay_ips)
  [ -n "$v4" ] || fail "SERVICES_PASSTHROUGH_IPV4 not found in apps/com/wrangler.toml"
  say "  relay addresses in the repo: $v4  $v6"
  local ips; ips=$(flyctl ips list -a flagship-services 2>&1 || true)
  echo "$ips" | sed 's/^/    /'
  if echo "$ips" | ips_agree "$v4" "$v6"; then ok "flyctl agrees with wrangler.toml"
  else fail "flyctl ips and apps/com/wrangler.toml disagree: fix the repo first (zone-health compares against the Worker's variables)"; fi
  cat <<EOF

  In the Cloudflare dashboard, flagship.services zone -> DNS -> Records. Proxy status MUST be
  "DNS only" (grey cloud) on both wildcard records; the dashboard offers orange by default.

      Type   Name            Content                   Proxy        TTL
      A      *               $v4              DNS only     60 s or Auto
      AAAA   *               $v6      DNS only     60 s or Auto
      CAA    @               0 issue "letsencrypt.org"
      CAA    @               0 issuewild "letsencrypt.org"

  After the CAA pair, check SSL/TLS -> Edge Certificates still shows the apex certificate active.
EOF
  local a; a=$(ask_word "Type  done  when the four records exist")
  [ "$a" = done ] || return 10
  PROBE_FAILS=0
  local i got6 got4 caa
  for i in 1 2 3 4 5 6; do
    got4=$(dig +short A anything-at-all.flagship.services @1.1.1.1 2>/dev/null | head -1 || true)
    [ "$got4" = "$v4" ] && break; sleep 5
  done
  if [ "$got4" = "$v4" ]; then ok "wildcard A answers the relay ($got4)"; else err "wildcard A answered '$got4', want $v4"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  if [ -n "$v6" ]; then
    got6=$(dig +short AAAA anything-at-all.flagship.services @1.1.1.1 2>/dev/null | head -1 || true)
    if [ "$got6" = "$v6" ]; then ok "wildcard AAAA answers the relay ($got6)"; else err "wildcard AAAA answered '$got6', want $v6"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  fi
  caa=$(dig +short CAA flagship.services @1.1.1.1 2>/dev/null || true)
  if echo "$caa" | grep -q issuewild && echo "$caa" | grep -q 'letsencrypt.org'; then ok "apex CAA pair visible"; else err "apex CAA not visible yet: '$caa'"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  say "  (zone-health is not deployed yet: it runs as a post-check of the .com deploy.)"
  st_w set dnsWildcardAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  probe_end
}

# publish_arch ARCH -> 0 published, 20 not ready/deferred
find_green_run() { # find_green_run arch -> run id of the newest green main run of that arch built after the endorsement
  local arch=$1 after id ids
  after=$(st_get endorsedAt)
  ids=$( (cd "$WT" && gh run list --workflow vm-appliance.yml --branch main --json databaseId,status,conclusion,headSha,createdAt --limit 20 2>/dev/null) | runs_after "$after" || true)
  for id in $ids; do
    if (cd "$WT" && gh api "repos/{owner}/{repo}/actions/runs/$id/artifacts" 2>/dev/null) | artifacts_have "$arch"; then echo "$id"; return 0; fi
  done
  return 0
}
smoke_ok() { # smoke_ok run-id
  local r; r=$( (cd "$WT" && gh run view "$1" --json jobs 2>/dev/null) | smoke_state || true)
  [ "$r" = success ]
}
publish_arch() {
  local arch=$1 id=""
  id=$(find_green_run "$arch")
  if [ -z "$id" ]; then
    warn "no green $arch run on main built after the endorsement ($(st_get endorsedAt))."
    (cd "$WT" && gh run list --workflow vm-appliance.yml --limit 6) | sed 's/^/    /' || true
    local a; a=$(ask_word "[w]ait for the running build, [t]ype a run id yourself, or [d]efer $arch (default d)")
    case "$a" in
      w|W) local r
           for r in $(cd "$WT" && gh run list --workflow vm-appliance.yml --status in_progress --json databaseId -q '.[].databaseId'); do
             (cd "$WT" && gh run watch "$r" --exit-status >/dev/null 2>&1) || true
           done
           id=$(find_green_run "$arch") ;;
      t|T) id=$(ask_word "Run id") ;;
    esac
    if [ -z "$id" ]; then st_w add deferred "$arch"; warn "$arch deferred: publish it in phase B (publisharm)"; return 20; fi
  fi
  smoke_ok "$id" || { err "run $id: the boot smoke step is not green"; st_w add deferred "$arch"; return 20; }
  ok "$arch: run $id is green with the boot smoke passing"
  confirm "Publish the $arch appliance from run $id to R2 (uploads about 2.5 GB)?" || { st_w add deferred "$arch"; return 20; }
  [ "$(free_gb "$HOME")" -ge 5 ] || fail "need more than 5 GB free to download the appliance"
  XA "$WT" env "PATH=$PATH" bash scripts/publish-vm-appliance.sh "$id"
  local mf="$WT/apps/web/public/downloads/FlagshipVMAppliance-$arch.json" commit sha
  commit=$(json_field commit < "$mf"); sha=$(json_field sha256 < "$mf")
  local endorsed; endorsed=$(st_get endorsed)
  if [ -n "$endorsed" ] && [ "$commit" != "$endorsed" ]; then warn "the $arch image bakes $(short "$commit"), not the endorsed $(short "$endorsed")"; confirm "Publish it anyway?" || return 11; fi
  st_w set "appliance_$arch" "$sha"
  st_w set "applianceRun_$arch" "$id"
  st_w del deferred "$arch"
  commit_paths "Publish the rebuilt $arch VM appliance" "apps/web/public/downloads/FlagshipVMAppliance-$arch.json"
  return 0
}
run_publish() {
  ensure_wt
  local rc=0 pushed=0
  publish_arch amd64 || rc=$?
  if [ "$rc" = 20 ]; then warn "amd64 is not ready: the Windows test needs it. Resume this step later with --only $CURRENT_STEP."; return 20; fi
  [ "$rc" = 0 ] || return "$rc"
  rc=0
  say "  arm64 may be skipped here and published in phase B."
  publish_arch arm64 || rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 20 ] || return "$rc"
  land_commits || return $?
}

run_redeployA() {
  com_deploy || return $?
  com_checks
  local arch want got
  for arch in amd64 arm64; do
    want=$(st_get "appliance_$arch")
    [ -n "$want" ] || continue
    got=$(curl -s -m 25 "$COM_URL/downloads/FlagshipVMAppliance-$arch.json" | json_field sha256 || true)
    if [ "$got" = "$want" ]; then ok "live $arch manifest sha256 matches the published run"; else err "live $arch manifest sha256 '$got', published '$want'"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  done
  probe_end
}

run_status() {
  ensure_wt
  local date out; date=$(date -u +%Y-%m-%d); out="$RELEASE_HOME/DEPLOYED-FINAL-$date.md"
  local endorsed shell deployed arch row="" dns_at
  endorsed=$(st_get endorsed); [ -n "$endorsed" ] || endorsed=$(latest_endorsed)
  shell=$(live_shell_version)
  for arch in amd64 arm64; do
    if [ -f "$WT/apps/web/public/downloads/FlagshipVMAppliance-$arch.json" ] && [ -n "$(st_get "appliance_$arch")" ]; then
      row="$row- $arch: sha256 \`$(st_get "appliance_$arch")\` (run $(st_get "applianceRun_$arch"), bakes \`$(json_field commit < "$WT/apps/web/public/downloads/FlagshipVMAppliance-$arch.json")\`)
"
    else row="$row- $arch: NOT published yet (the older image is still what Studio downloads for $arch)
"; fi
  done
  dns_at=$(st_get dnsWildcardAt)
  {
    echo "# DEPLOYED-FINAL $date"
    echo
    echo "This is the real deployed state the Windows test should run against. Nothing below is a caveat: if a line is not true when you test, stop and report it."
    echo
    echo "- main (release pin): \`$PIN\`"
    echo "- endorsed release commit (what new boxes install): \`$endorsed\`"
    echo "- .com deployed from: \`$(st_get comDeployedSha)\`, webapp shell version live: \`${shell:-unknown}\`"
    echo "- .services (Fly relay): deployed from this release"
    echo "- DNS design: the flagship.services zone holds a root wildcard (\`*\` A and AAAA, DNS only, grey cloud, pointing at the relay) and an apex CAA pair (issue and issuewild: letsencrypt.org). Accounts and boxes hold no address or CAA records; only short-lived \`_acme-challenge\` TXT records exist during issuance. Rollout order: the relay (.services) was deployed first, then the wildcard and CAA were added (${dns_at:-time unknown}), then the new .com; existing accounts kept their own records until the phase B reap."
    echo "- Workers plan: $(st_get workersPlan)"
    echo "- Published VM appliances (Studio \"Host on this PC\" downloads these):"
    printf '%s' "$row"
    echo "- Not live yet (phase B, after the Windows results): the public Windows and Linux Studio release, the pre-GA scrub and reap, the store builds."
    echo "- Windows Studio under test is still the previous build; the download links on the site are unchanged."
  } > "$out"
  hdr "Status file ($out)"
  cat "$out"
  echo
  confirm "Commit this to branch $RESULTS_BRANCH as device-results/DEPLOYED-FINAL-$date.md (plain push, no force)?" || { say "  left at $out"; return 0; }
  local tw="$RELEASE_HOME/wt-results"
  X git -C "$REPO" fetch -q origin "$RESULTS_BRANCH"
  case "$tw" in "$RELEASE_HOME"/*) rm -rf "$tw" ;; esac
  git -C "$REPO" worktree prune
  X git -C "$REPO" worktree add --detach "$tw" "origin/$RESULTS_BRANCH"
  mkdir -p "$tw/device-results"
  cp "$out" "$tw/device-results/DEPLOYED-FINAL-$date.md"
  X git -C "$tw" add -- "device-results/DEPLOYED-FINAL-$date.md"
  X git -C "$tw" commit -q -m "Record the deployed final state for the Windows test ($date)" -- "device-results/DEPLOYED-FINAL-$date.md"
  local rc=0
  git -C "$tw" push origin "HEAD:refs/heads/$RESULTS_BRANCH" || rc=$?
  git -C "$REPO" worktree remove --force "$tw" >/dev/null 2>&1 || true
  [ "$rc" = 0 ] || fail "the push to $RESULTS_BRANCH was not a fast-forward (someone pushed to it): fetch it and run this step again"
  ok "pushed to $RESULTS_BRANCH"
}

run_notice() {
  ensure_wt
  local msg event
  msg="We will update Flagship on {date}. Your servers keep running, but flagshipserver.com may be briefly unavailable."
  event=$(ask_word "When is the scrub? ISO time, e.g. 2026-10-22T09:00:00Z (Enter = skip the notice)")
  [ -n "$event" ] || { ok "no notice"; return 0; }
  say "  Preview (writes nothing):"
  with_maintainers XA "$WT" node scripts/security-notice.mjs maintenance --message "$msg" --event "$event"
  st_w set noticeEvent "$event"
  cat <<EOF

  To publish it, sign in ANOTHER terminal (the YubiKey PIN prompt reads /dev/tty):

      cd $WT
      ln -s $MAIN_CHECKOUT/maintainers maintainers
      node scripts/security-notice.mjs maintenance --message "$msg" --event $event --sign
      rm maintainers

  Then come back here. This step commits .maintainers/notices, pushes it and redeploys .com.
EOF
  local a; a=$(ask_word "Type  signed  when done, or press Enter to leave the notice for later")
  [ "$a" = signed ] || { warn "no notice published"; return 0; }
  [ -n "$(wt_git status --porcelain -- .maintainers/notices)" ] || fail "nothing new under .maintainers/notices in the worktree"
  commit_paths "Notice: maintenance on ${event%%T*}" .maintainers/notices
  land_commits || return $?
  com_deploy || return $?
  say "  $(curl -s -m 25 "$COM_URL/api/notices" | head -c 400)"
  com_checks
}

DANGER_TABLES="servers routing auth_codes device_identities daemon_status secret_mailbox meter_counters audit_events demo_users"
run_scrub() {
  ensure_wt
  if [ ! -f "$WT/scripts/wipe-all-users.sh" ]; then ok "scripts/wipe-all-users.sh is already retired on this commit: nothing to scrub"; return 0; fi
  hdr "GA go/no-go gate"
  cat <<'EOF'
  The scrub deletes EVERY account on prod except playstore-test-0725 (the shared App Store /
  Google Play review login: do not run it while a store review is open and that account is
  missing). It cannot be undone except from the export taken below.
    [ ] the Windows device results (branch device-results/*) were reviewed and nothing blocks GA
    [ ] the maintenance notice has been live long enough (event time recorded: see below)
    [ ] nobody has a test account they still need
EOF
  say "  notice event time on record: $(st_get noticeEvent)"
  local a; a=$(ask_word "Type  windows-ok  (results reviewed) or  skip-windows  (explicitly skipping them)")
  case "$a" in windows-ok|skip-windows) st_w set windowsGate "$a" ;; *) fail "gate not passed ('$a')" ;; esac
  local stamp; stamp=$(date -u +%Y%m%dT%H%M%SZ)
  confirm "Export prod D1 to ~/d1-before-scrub-$stamp.sql first (read-only, a local file)?" || return 10
  WRX d1 export flagship-state --remote --output "$HOME/d1-before-scrub-$stamp.sql"
  say "  demo users with a running cloud server (the reap removes them after the wipe):"
  WRQ d1 execute flagship-state --remote --command "SELECT username, state, active_server_id FROM demo_users WHERE active_server_id IS NOT NULL" 2>&1 | tail -20 | sed 's/^/    /' || true
  hdr "Dry run (every query is a SELECT)"
  XA "$WT" env WIPE_ENV=prod WIPE_D1=flagship-state bash scripts/wipe-all-users.sh --list-accounts
  say "  Read the keep list and the accounts above. The kept account must be playstore-test-0725 only."
  confirm "Go: run the REAL wipe on prod? (the tool then asks you to type flagship-state)" || return 10
  XA "$WT" env WIPE_ENV=prod WIPE_D1=flagship-state WIPE_CONFIRM=prod bash scripts/wipe-all-users.sh --yes
  hdr "Verify (read-only)"
  local users orphans
  users=$(WRQ d1 execute flagship-state --remote --json --command "SELECT username FROM usernames ORDER BY username" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log((Array.isArray(p)?p:[p]).flatMap(r=>r.results||[]).map(r=>r.username).join(" "))})' || true)
  say "  accounts left: $users"
  [ "$users" = playstore-test-0725 ] && ok "only the review account remains" || { err "expected only playstore-test-0725"; PROBE_FAILS=$((PROBE_FAILS + 1)); }
  orphans=$(WRQ d1 execute flagship-state --remote --json --command "SELECT (SELECT count(*) FROM servers WHERE lower(username) NOT IN (SELECT lower(username) FROM usernames)) AS a, (SELECT count(*) FROM device_identities WHERE account_id NOT IN (SELECT username FROM usernames)) AS b, (SELECT count(*) FROM daemon_status WHERE lower(server_domain) NOT IN (SELECT lower(server_domain) FROM servers)) AS c, (SELECT count(*) FROM auth_codes WHERE lower(username) NOT IN (SELECT lower(username) FROM usernames)) AS d" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);const r=(Array.isArray(p)?p:[p]).flatMap(x=>x.results||[])[0]||{};console.log([r.a,r.b,r.c,r.d].join(" "))})' || true)
  if [ "$orphans" = "0 0 0 0" ]; then ok "the four orphan counts are 0"; else err "orphan counts: '$orphans'"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  say "  Now sign in as the review login (demo test-account entry, playstore-test-0725) on a phone or the webapp and open its server list."
  [ "$(ask_word "Does it sign in and show its server? (y/n)")" = y ] || PROBE_FAILS=$((PROBE_FAILS + 1))
  probe_end
}

GYM_LOCK="${FLAGSHIP_GYM_LOCK:-/private/tmp/claude-501/flagship-locks/gym.lock}"
gym_lock_held() { [ -e "$GYM_LOCK" ]; }

# What no tool can see: each needs the owner's own login. The ids are the state keys.
OWNER_CHECK_IDS="upcloud hetzner cfcom r2 fly"
owner_check_text() { # owner_check_text id
  case "$1" in
    upcloud) echo "UpCloud console: servers WITHOUT the flagship-demo label (the reap only sees labelled ones). Keep only the playstore-test-0725 server." ;;
    hetzner) echo "Hetzner (account suspended): delete servers 153213447, 153638469, 153643080, 153813669, 155315594 when it unlocks." ;;
    cfcom) echo "Cloudflare zone flagshipserver.com: stale records pointing at retired hosts (the old web. record pointed at an unclaimed Surge site)." ;;
    r2) echo "R2 buckets: per-account objects of wiped accounts (flagship-d1-backups and flagship-iso must stay)." ;;
    fly) echo "Fly: apps, volumes and secrets besides flagship-services (flyctl apps list; flyctl volumes list -a flagship-services)." ;;
    *) return 1 ;;
  esac
}
run_owner_checklist() {
  local id a results=""
  hdr "Owner checklist: what the tools cannot see"
  say "  The reap sees the services-zone DNS and UpCloud servers labelled flagship-demo. These need your own logins:"
  for id in $OWNER_CHECK_IDS; do say "    - $(owner_check_text "$id")"; done
  for id in $OWNER_CHECK_IDS; do
    a=$(ask_word "$id: type  checked  or  skipped")
    case "$a" in checked|skipped) results="$results $id=$a" ;; *) fail "answer checked or skipped for $id (got '$a'); rerun the step" ;; esac
  done
  results="${results# }"
  st_w set reapOwnerChecklist "$results"
  case "$results" in *skipped*) warn "skipped by you: $results" ;; *) ok "owner checklist: $results" ;; esac
}
reap_review_ack() { # a typed 'reviewed' once the left-on-purpose list was shown
  local a; a=$(ask_word "Read what was left on purpose above. Type  reviewed  to go on")
  [ "$a" = reviewed ] || fail "not acknowledged ('$a'): read the left-on-purpose list, then rerun the step"
  st_w set reapReviewed "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

run_reap() {
  require_done scrub || return 10
  ensure_wt
  need_admin_secret || fail "the reap talks to the .com admin routes: the admin secret is required"
  hdr "Gym leftovers (shared services zone and gym servers)"
  say "  The sweep removes every gym-labelled server and gym DNS record through the gym Worker (never prod's)."
  local g; g=$(ask_word "Type  sweep  to sweep them now, or  skip-gym  to skip it (only while no live gym run is in progress)")
  case "$g" in
    sweep)
      if gym_lock_held; then
        fail "a live gym run holds $GYM_LOCK: wait for it to finish (or remove the lock only if you know it is stale), then rerun this step"
      fi
      XA "$WT" npx tsx tools/live-e2e/sweep-cli.ts
      confirm "Destroy those gym leftovers (sweep-cli --destroy)? If it reports dnsFailed, wait 30 s and run it again." || return 10
      XA "$WT" npx tsx tools/live-e2e/sweep-cli.ts --destroy
      st_w set reapGymSweep swept ;;
    skip-gym) warn "gym sweep skipped by you: shared-zone gym records and gym servers may remain"; st_w set reapGymSweep skipped ;;
    *) fail "answer sweep or skip-gym (got '$g'); rerun the step" ;;
  esac
  local plan="$HOME/pre-ga-reap-plan.json" after="$HOME/pre-ga-reap-plan-after.json"
  hdr "Reap dry run (writes nothing in Cloudflare, UpCloud or D1)"
  printf '%s+ node scripts/reap-orphans.mjs --show --out %s%s\n' "$C_D" "$plan" "$C_0"
  with_secret bash -c "cd '$WT' && node scripts/reap-orphans.mjs --show --out '$plan'" || fail "the reap dry run failed"
  say "  Read it: orphans are the wiped accounts; the kept list is exactly playstore-test-0725; the zone after the reap is well under 200."
  confirm "Apply this plan? (the tool prints it again and asks you to type 'delete N records and M servers')" || return 10
  printf '%s+ node scripts/reap-orphans.mjs --apply --plan %s%s\n' "$C_D" "$plan" "$C_0"
  with_secret bash -c "cd '$WT' && node scripts/reap-orphans.mjs --apply --plan '$plan'" || fail "the reap apply reported failures (see $plan.log.jsonl); rerun the step"
  hdr "Verify"
  with_secret bash -c "cd '$WT' && node scripts/reap-orphans.mjs --show --out '$after'" || fail "the second dry run failed: the left-on-purpose review needs it; rerun the step"
  with_secret bash -c "cd '$WT' && npm run -s zone-health" || { PROBE_FAILS=$((PROBE_FAILS + 1)); err "zone-health is not OK"; }
  hdr "Left on purpose (from the second dry run)"
  printf '%s+ node scripts/reap-orphans.mjs --review --plan %s%s\n' "$C_D" "$after" "$C_0"
  ( cd "$WT" && node scripts/reap-orphans.mjs --review --plan "$after" ) || { PROBE_FAILS=$((PROBE_FAILS + 1)); err "the second dry run still lists records or servers to delete"; }
  say "  The protected review account keeps its own records (a warning) until its store review ends."
  probe_end || return $?
  reap_review_ack
  run_owner_checklist
}

run_retire() {
  require_done scrub reap || return 10
  ensure_wt
  X git -C "$WT" fetch -q origin chore/delete-wipe-tooling
  local branch=retire-wipe-tooling
  wt_git branch -D "$branch" >/dev/null 2>&1 || true
  X git -C "$WT" switch -q -c "$branch" origin/chore/delete-wipe-tooling
  if ! wt_git rebase origin/main >/dev/null 2>&1; then
    wt_git rebase --abort >/dev/null 2>&1 || true
    fail "rebasing chore/delete-wipe-tooling onto main conflicts: rebase it by hand, then run this step again"
  fi
  say "  commits that would land:"; wt_git log --oneline --no-decorate origin/main..HEAD | sed 's/^/    /'
  wt_git diff --stat origin/main HEAD | tail -12 | sed 's/^/    /'
  XA "$WT" npx tsc -b
  XA "$WT" npx vitest run scripts
  XA "$WT" env RELEASE=1 bash scripts/release-guard.sh
  land_commits || { local rc=$?; wt_git switch -q --detach "$PIN" 2>/dev/null || true; return $rc; }
  X git -C "$WT" switch -q --detach "$PIN"
  wt_git branch -D "$branch" >/dev/null 2>&1 || true
}

studio_version() { node -p "require('$WT/release/version.json').studio"; }
run_studiowl() {
  ensure_wt
  local v tag; v=$(studio_version); tag="studio-v$v"
  say "  Studio version from release/version.json: $v (tag $tag)"
  say "  Windows is unsigned and neither Windows nor Linux has run on real hardware beyond the recorded Windows run: they ship as preview."
  if (cd "$WT" && gh release view "$tag" >/dev/null 2>&1); then
    ok "release $tag already exists: skipping the build"
  else
    confirm "Dispatch studio-release.yml with publish=true (creates the PUBLIC GitHub release $tag)?" || return 10
    local t0; t0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    XA "$WT" gh workflow run studio-release.yml --ref main -f publish=true
    sleep 8
    local id sha
    id=$(cd "$WT" && gh run list --workflow studio-release.yml --event workflow_dispatch --limit 3 --json databaseId,createdAt -q "[.[]|select(.createdAt>=\"$t0\")][0].databaseId" 2>/dev/null || true)
    [ -n "$id" ] || fail "could not find the dispatched run"
    sha=$(cd "$WT" && gh run view "$id" --json headSha -q .headSha)
    [ "$sha" = "$PIN" ] || { err "the workflow built $sha, not the pinned $PIN"; confirm "Continue watching it anyway?" || return 11; }
    XA "$WT" gh run watch "$id" --exit-status
  fi
  local assets win lin
  assets=$(cd "$WT" && gh release view "$tag" --json assets -q '.assets[].name')
  win=$(echo "$assets" | grep -x "FlagshipStudio-Windows-x64-$v.zip" || true)
  lin=$(echo "$assets" | grep -x "FlagshipStudio-Linux-x86_64-$v.AppImage" || true)
  [ -n "$win" ] && [ -n "$lin" ] || fail "the release lacks the expected Windows zip / Linux AppImage names (have: $(echo $assets | tr '\n' ' '))"
  ok "assets: $win, $lin"
  ( cd "$WT" && node -e '
const fs=require("fs");const v=process.argv[1];
for(const f of ["apps/com/src/route.ts","apps/com/test/route.test.ts"]){
  let s=fs.readFileSync(f,"utf8");
  s=s.replace(/studio-v\d+\.\d+\.\d+\/FlagshipStudio-Windows-x64-\d+\.\d+\.\d+\.zip/g,`studio-v${v}/FlagshipStudio-Windows-x64-${v}.zip`)
     .replace(/studio-v\d+\.\d+\.\d+\/FlagshipStudio-Linux-x86_64-\d+\.\d+\.\d+\.AppImage/g,`studio-v${v}/FlagshipStudio-Linux-x86_64-${v}.AppImage`);
  fs.writeFileSync(f,s)}' "$v" )
  if [ -z "$(wt_git status --porcelain -- apps/com/src/route.ts apps/com/test/route.test.ts)" ]; then ok "route.ts already points at $tag"; return 0; fi
  XA "$WT" npx vitest run apps/com/test/route.test.ts
  commit_paths "Point the Windows and Linux Studio downloads at $tag" apps/com/src/route.ts apps/com/test/route.test.ts
  land_commits || return $?
}

run_studiomac() {
  ensure_wt
  local v; v=$(studio_version)
  say "  Mac Studio $v. scripts/release-studio.sh builds, signs, notarizes (uploads to Apple, a few minutes) and stages the DMG; it publishes nothing."
  say "  Needs the Developer ID in your keychain and the notary profile (flagship-studio); see the script header."
  confirm "Build, sign and notarize the Mac Studio now?" || return 10
  XA "$WT" bash scripts/release-studio.sh
  local dmg="$WT/apps/web/public/downloads/FlagshipStudio.dmg"
  [ -f "$dmg" ] || fail "the DMG was not staged"
  X spctl -a -vv -t install "$dmg"
  commit_paths "Publish a new Flagship Studio build" apps/web/public/downloads/FlagshipStudio.dmg
  land_commits || return $?
  say "  The .com redeploy that serves it is the redeploy step."
}

run_publisharm() {
  ensure_wt
  if [ -n "$(st_get appliance_arm64)" ]; then ok "arm64 was already published in phase A"; return 0; fi
  local rc=0
  publish_arch arm64 || rc=$?
  [ "$rc" = 0 ] || return "$rc"
  land_commits || return $?
}

run_redeployB() {
  com_deploy || return $?
  com_checks
  PROBE_FAILS=0
  local os
  for os in mac windows linux; do
    local loc; loc=$(curl -sI -m 25 "$COM_URL/download/$os" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | head -1)
    if [ -n "$loc" ]; then ok "/download/$os -> $loc"; else err "/download/$os did not redirect"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  done
  local v; v=$(studio_version)
  curl -sI -m 25 "$COM_URL/download/windows" | grep -qi "studio-v$v" && ok "windows redirect names studio-v$v" || { err "windows redirect is not studio-v$v"; PROBE_FAILS=$((PROBE_FAILS + 1)); }
  probe_end
}

xcode_dir() {
  if [ -d /Applications/Xcode-27.1.0-Release.Candidate.app ]; then echo /Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer; else xcode-select -p; fi
}
run_ios() {
  ensure_wt
  [ "$(free_gb "$HOME")" -ge 5 ] || fail "need more than 5 GB free for an iOS build"
  [ -d /private/tmp/claude-501/flagship-locks/native-build.lock ] && warn "an agent session holds the native-build lock: wait for it"
  local team iv ib
  team=$(sed -n 's/^ *DEVELOPMENT_TEAM: *\([A-Z0-9]*\).*/\1/p' "$WT/apps/mobile/ios/App/project.yml" | head -1)
  [ -n "$team" ] || fail "no DEVELOPMENT_TEAM in project.yml"
  iv=$(node -p "require('$WT/release/version.json').iosVersion"); ib=$(node -p "require('$WT/release/version.json').iosBuild")
  say "  App Store version $iv build $ib (from release/version.json), team $team."
  say "  The upload burns the build number: App Store Connect must not already hold build $ib for $iv."
  confirm "Build, archive and (next prompt) upload iOS $iv ($ib)?" || return 10
  local dev; dev=$(xcode_dir)
  local tmp; tmp=$(mktemp -d "$RELEASE_HOME/ios.XXXXXX")
  XA "$WT" env "DEVELOPER_DIR=$dev" node scripts/ios-release-clean.mjs --build
  cat > "$tmp/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
  XA "$WT" env "DEVELOPER_DIR=$dev" xcodebuild archive -project apps/mobile/ios/App/FlagshipApp.xcodeproj -scheme FlagshipApp -destination 'generic/platform=iOS' -archivePath "$tmp/FlagshipApp.xcarchive" -derivedDataPath "$tmp/dd" -allowProvisioningUpdates
  rm -rf "$tmp/dd"
  if confirm "UPLOAD $iv ($ib) to App Store Connect now (xcodebuild -exportArchive with destination upload)?"; then
    XA "$WT" env "DEVELOPER_DIR=$dev" xcodebuild -exportArchive -archivePath "$tmp/FlagshipApp.xcarchive" -exportOptionsPlist "$tmp/ExportOptions.plist" -allowProvisioningUpdates
    st_w set iosUploaded "$iv ($ib)"
  else
    warn "archive kept at $tmp/FlagshipApp.xcarchive; Xcode Organizer can distribute it"
    return 0
  fi
  rm -rf "$tmp"
  say "  Still manual: App Store Connect export-compliance answer, 'iPhone and iPad Apps on Apple Silicon Macs', and submitting the build for review."
}

run_android() {
  ensure_wt
  local jh=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  [ -d "$jh" ] || fail "JAVA_HOME $jh is missing (brew install openjdk@17)"
  [ -f "$MAIN_CHECKOUT/apps/mobile/android/keystore/keystore.properties" ] || fail "apps/mobile/android/keystore/keystore.properties is missing in your checkout: without it the release is debug-signed and Play rejects it"
  local vc; vc=$(node -p "require('$WT/release/version.json').androidVersionCode")
  say "  versionCode $vc (wear $((vc + 1000000))). Version codes are burned by any upload."
  local top; top=$(ask_word "Highest versionCode in Play Console -> App bundle explorer?")
  [[ "$top" =~ ^[0-9]+$ ]] || fail "type a number"
  if [ "$vc" -le "$top" ]; then fail "release/version.json androidVersionCode $vc must be above $top: raise it, run node scripts/check-versions.mjs --write, commit, and run this step again"; fi
  confirm "Build the Android release bundles (the upload key is linked from your checkout, never copied)?" || return 10
  local links=(local.properties apps/mobile/android/local.properties apps/mobile/android/keystore/keystore.properties)
  local kf; for kf in "$MAIN_CHECKOUT"/apps/mobile/android/keystore/*.jks "$MAIN_CHECKOUT"/apps/mobile/android/keystore/*.keystore; do [ -e "$kf" ] && links+=("apps/mobile/android/keystore/$(basename "$kf")"); done
  link_local_files "${links[@]}"
  local rc=0
  ( cd "$WT/apps/mobile/android" \
    && printf '%s+ ./gradlew :app:assembleRelease :wear:assembleRelease :app:bundleRelease :wear:bundleRelease%s\n' "$C_D" "$C_0" \
    && JAVA_HOME="$jh" ./gradlew :app:assembleRelease :wear:assembleRelease :app:bundleRelease :wear:bundleRelease \
    && printf '%s+ bash scripts/check-release-clean.sh%s\n' "$C_D" "$C_0" \
    && bash scripts/check-release-clean.sh ) || rc=$?
  if [ "$rc" != 0 ]; then unlink_local_files "${links[@]}"; fail "the Android build or the release-clean check failed"; fi
  local out="$ARTIFACTS/$(short "$PIN")"; mkdir -p "$out"
  local aab
  while IFS= read -r aab; do cp "$aab" "$out/"; done < <(find "$WT/apps/mobile/android/app/build/outputs/bundle/release" "$WT/apps/mobile/android/wear/build/outputs/bundle/release" -name '*.aab' 2>/dev/null)
  unlink_local_files "${links[@]}"
  ok "AABs copied to $out:"
  ( cd "$out" && shasum -a 256 ./*.aab ) | sed 's/^/    /'
  say "  Upload by hand: the phone AAB to the Play internal track, the wear AAB under the Wear OS form factor."
  st_w set androidAabDir "$out"
}

run_final() {
  ensure_wt
  PROBE_FAILS=0
  hdr "Final probes"
  probe_code ".com health" "$COM_URL/api/health" 200
  probe_code ".services health" "$SERVICES_URL/api/health" 200
  probe_code "status page" "$COM_URL/status/" 200
  probe_code "webapp" "$WEBAPP_URL/" 200
  local n; n=$(http_code "$COM_URL/api/notices"); say "  info  notices: $n"
  local arch
  for arch in amd64 arm64; do probe_code "$arch appliance manifest" "$COM_URL/downloads/FlagshipVMAppliance-$arch.json" 200; done
  if need_admin_secret; then
    say "  zone-health:"; with_secret bash -c "cd '$WT' && npm run -s zone-health" || { err "zone-health not OK"; PROBE_FAILS=$((PROBE_FAILS + 1)); }
    say "  schema-status:"; admin_curl "$COM_URL/api/admin/schema-status" | head -c 600; echo
  fi
  local e; e=$(st_get endorsed)
  if [ -n "$e" ] && wt_exists; then
    say "  box code changed on main since the endorsed release $(short "$e"):"
    wt_git diff --stat "$e" "$PIN" -- "${BOX_PATHS[@]}" | tail -8 | sed 's/^/    /'
  fi
  probe_end || true
  summary
}

summary() {
  local v; v=$(cat "$REPO/release/version.json" 2>/dev/null | tr -d '\n ')
  hdr "Release summary"
  cat <<EOF
  commit pinned at the end:  $PIN
  first pinned (TARGET):     $(st_get target)
  endorsed release:          $(st_get endorsed)
  versions (release/version.json): $v
  .com shell version live:   $(live_shell_version)
  deployed:                  $COM_URL  $SERVICES_URL  $WEBAPP_URL
  appliances published:      amd64 $(st_get appliance_amd64)  arm64 $(st_get appliance_arm64)
  steps deferred:            $(st_get deferred)

  Still manual:
   - App Store Connect: export-compliance answer, the Apple Silicon Mac option, submit build for review
   - Google Play: upload the two AABs ($(st_get androidAabDir)) to the internal track (Wear under Wear OS), then promote
   - Windows signing is not set up (preview); Windows and Linux Studio have no real-hardware run beyond the recorded one
   - never tear down the review account playstore-test-0725 while a store review is open
   - take any DNS leftovers of that review account by hand when its review ends
   - AGENTS.md "Current status": record this release
EOF
}

# ---------------------------------------------------------------- runner

on_exit() {
  local rc=$?
  trap - EXIT
  unset FLAGSHIP_ADMIN_SECRET ADMIN_SECRET
  if [ "$rc" -ne 0 ] && [ -n "$CURRENT_STEP" ] && [ "$DRY" = 0 ]; then
    printf '\n%sStopped in step %s (%s).%s\n' "$C_R" "$CURRENT_STEP" "$(step_id "$CURRENT_STEP")" "$C_0" >&2
    [ -f "$STATE" ] && st set failed "$CURRENT_STEP" 2>/dev/null || true
    printf 'Fix the cause, then resume:   bash scripts/release.sh --from %s\n' "$CURRENT_STEP" >&2
  fi
  if [ "$HAVE_LOCK" = 1 ]; then
    if [ -e "$WT/.git" ]; then
      rm -f "$WT/maintainers" 2>/dev/null || true
      git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
    fi
    git -C "$REPO" worktree prune >/dev/null 2>&1 || true
    rm -rf "$LOCKDIR"
  fi
  exit "$rc"
}
on_err() { [ "$DRY" = 1 ] || printf '%s  error at line %s: %s%s\n' "$C_R" "$1" "$2" "$C_0" >&2; }

take_lock() {
  mkdir -p "$RELEASE_HOME"
  if mkdir "$LOCKDIR" 2>/dev/null; then echo $$ > "$LOCKDIR/pid"; HAVE_LOCK=1; return 0; fi
  local other; other=$(cat "$LOCKDIR/pid" 2>/dev/null || echo 0)
  if [ "$other" != 0 ] && kill -0 "$other" 2>/dev/null; then fail "another release run (pid $other) is active"; fi
  warn "removing a stale lock from pid $other"
  rm -rf "$LOCKDIR"; mkdir "$LOCKDIR"; echo $$ > "$LOCKDIR/pid"; HAVE_LOCK=1
}

step_prompt() { # idx -> 0 run, 1 skip; exit on N/quit
  local a; printf '%sRun step %s?%s [y/N/skip/quit] ' "$C_Y" "$1" "$C_0"
  read -r a || a=""
  case "$a" in
    y|Y|yes) return 0 ;;
    skip|s|S) return 1 ;;
    quit|q|Q) say "quit. Resume with: bash scripts/release.sh --from $1"; exit 0 ;;
    *) say "not run. Resume with: bash scripts/release.sh --from $1"; exit 0 ;;
  esac
}

phase_open() { # steps of a phase that are neither done nor skipped
  local i out=""
  for ((i = $(phase_first "$1"); i <= $(phase_last "$1"); i++)); do
    if ! st_has done "$i" && ! st_has skipped "$i"; then out="$out $i"; fi
  done
  echo "${out# }"
}
phase_complete() { [ -z "$(phase_open "$1")" ]; }

run_steps() { # run_steps first last forced_first_flag phase
  local first=$1 last=$2 forced=$3 phase=$4 idx id rc stopped=0
  for ((idx = first; idx <= last; idx++)); do
    id=$(step_id "$idx")
    if [ "$DRY" = 1 ]; then show_meta "$idx" full; continue; fi
    if st_has done "$idx" && ! { [ "$forced" = 1 ] && [ "$idx" = "$first" ]; }; then
      say "${C_G}[done]${C_0} $(printf '%02d' "$idx") $id (recorded earlier)"; continue
    fi
    CURRENT_STEP=$idx
    pin_guard
    hdr "Step $idx of $(step_count), phase $(step_phase "$idx")  |  pin $(short "$PIN")"
    show_meta "$idx" full
    if ! step_prompt "$idx"; then
      if [ "$REQUIRED" = 1 ]; then
        [ "$(ask_word "This step is required for the release. Type  skip-required  to skip it anyway")" = skip-required ] || { say "not skipped."; exit 0; }
      fi
      st_w add skipped "$idx"; warn "step $idx skipped"; CURRENT_STEP=""; continue
    fi
    rc=0
    "run_$id" || rc=$?
    case "$rc" in
      0)  st_w add done "$idx"; st_w del skipped "$idx"; ok "step $idx done"; CURRENT_STEP="" ;;
      20) st_w add deferred "$id"; warn "step $idx deferred (not done): resume later with --only $idx"; CURRENT_STEP=""; stopped=0 ;;
      10) CURRENT_STEP=""; say "step $idx stopped at a declined prompt. Resume with: bash scripts/release.sh --from $idx"; exit 0 ;;
      *)  fail "step $idx failed (code $rc)" ;;
    esac
  done
  if [ "$DRY" = 0 ] && [ -n "$phase" ] && [ "$last" = "$(phase_last "$phase")" ]; then
    if phase_complete "$phase"; then st_w set "phase$phase" finished; ok "phase $phase finished"
    else warn "phase $phase is NOT finished: steps still open: $(phase_open "$phase")"; fi
  fi
}

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

main() {
  local mode=run short=0 phase="" from="" only="" fresh=0 force_order=0 forced_first=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --list) mode=list ;;
      --short) short=1 ;;
      --dry-run) DRY=1 ;;
      --status) mode=status ;;
      --phase) shift; phase=${1:-}; [ "$phase" = A ] || [ "$phase" = B ] || { echo "--phase takes A or B" >&2; exit 2; } ;;
      --from) shift; from=${1:-} ;;
      --only) shift; only=${1:-} ;;
      --new) fresh=1 ;;
      --force-phase-order) force_order=1 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
  done
  local n; n=$(step_count)
  for v in "$from" "$only"; do
    if [ -n "$v" ] && { ! [[ "$v" =~ ^[0-9]+$ ]] || [ "$v" -lt 1 ] || [ "$v" -gt "$n" ]; }; then echo "step numbers are 1..$n" >&2; exit 2; fi
  done

  if [ "$mode" = list ]; then
    echo "Release plan: $n steps in two phases (A before the Windows test, B after the Windows results)"
    echo
    if [ "$short" = 1 ]; then list_plan short "$phase"; else list_plan full "$phase"; fi
    exit 0
  fi

  # the pin: recorded in the state file, else origin/main right now
  local sp; sp=$(st_get pinned)
  if [ "$fresh" = 1 ] && [ -f "$STATE" ] && [ "$DRY" = 0 ]; then
    mv "$STATE" "$STATE.bak-$(date +%s)"; sp=""
  fi
  if [ -n "$sp" ]; then PIN=$sp; else PIN=$(origin_main); fi

  if [ "$mode" = status ]; then
    echo "state file:  $STATE"
    echo "pinned:      ${PIN:-none}"
    echo "done steps:  $(st_get done)"
    echo "skipped:     $(st_get skipped)"
    echo "deferred:    $(st_get deferred)"
    echo "phase A:     $(st_get phaseA)   phase B: $(st_get phaseB)"
    local i next=""; for ((i = 1; i <= n; i++)); do st_has done "$i" || { next=$i; break; }; done
    echo "next step:   ${next:-none (release complete)}"
    exit 0
  fi

  # which phase
  if [ -n "$only" ]; then phase=$(step_phase "$only")
  elif [ -n "$from" ] && [ -z "$phase" ]; then phase=$(step_phase "$from")
  fi
  if [ -z "$phase" ]; then
    if [ "$DRY" = 1 ]; then phase=""; else
      [ -t 0 ] || { echo "run with --phase A or --phase B (stdin is not a terminal)" >&2; exit 2; }
      phase=$(ask_word "Which phase? A (deploy the real state, before the Windows test) or B (after the Windows results) [A/B]")
      phase=$(echo "$phase" | tr a-z A-Z)
      [ "$phase" = A ] || [ "$phase" = B ] || { echo "type A or B" >&2; exit 2; }
    fi
  fi

  if [ "$DRY" = 1 ]; then
    echo "[dry-run] nothing below is executed; no network, no worktree, no state written."
    echo "[dry-run] pinned commit: ${PIN:-unknown} ($(st_get done | wc -w | tr -d ' ') steps recorded done)"
    echo
    local f l
    if [ -n "$only" ]; then f=$only; l=$only
    else
      f=${from:-$( [ -n "$phase" ] && phase_first "$phase" || echo 1)}
      l=$( [ -n "$phase" ] && phase_last "$phase" || echo "$n")
      if [ -z "$from" ]; then
        # resume: the first step of the phase not yet done
        local i; for ((i = f; i <= l; i++)); do st_has done "$i" || { f=$i; break; }; done
      fi
    fi
    echo "[dry-run] would start at step $f"
    echo
    run_steps "$f" "$l" 1 "$phase"
    exit 0
  fi

  if [ "$phase" = B ] && [ "$(st_get phaseA)" != finished ]; then
    warn "phase A is not recorded as finished."
    if [ "$force_order" = 1 ]; then
      local why; why=$(ask_word "Type the reason for running phase B first")
      [ -n "$why" ] || fail "a reason is required"
      st set forcedPhaseOrder "$why"
    else
      { err "refusing to run phase B before phase A: finish it (bash scripts/release.sh --phase A) or pass --force-phase-order"; exit 1; }
    fi
  fi

  [ -t 0 ] || { echo "this script is interactive: run it from a terminal" >&2; exit 2; }
  unset FLAGSHIP_ADMIN_SECRET
  take_lock
  trap on_exit EXIT
  trap 'exit 130' INT TERM
  trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR

  git_fetch_main || fail "cannot fetch origin"
  if [ -z "$sp" ]; then
    PIN=$(origin_main)
    st set pinned "$PIN"; st set target "$PIN"; st set startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  hdr "Flagship release"
  say "  pinned commit:  $PIN  ($(git -C "$REPO" log -1 --format=%s "$PIN"))"
  say "  state file:     $STATE"
  say "  phase:          $phase"
  say "  worktree:       $WT (removed when this script exits)"

  local f l
  if [ -n "$only" ]; then f=$only; l=$only; forced_first=1
  else
    l=$(phase_last "$phase")
    if [ -n "$from" ]; then f=$from; forced_first=1
    else
      f=$(phase_first "$phase")
      local i; for ((i = f; i <= l; i++)); do st_has done "$i" || { f=$i; break; }; done
      if [ "$i" -gt "$l" ]; then say "phase $phase has every step recorded done. Use --new for a new release or --from N to redo a step."; exit 0; fi
    fi
  fi
  [ "$(step_phase "$f")" = "$phase" ] || fail "step $f belongs to phase $(step_phase "$f"), not $phase"
  run_steps "$f" "$l" "$forced_first" "$phase"
  CURRENT_STEP=""
  [ "$phase" = B ] && [ "$(st_get phaseB)" = finished ] && summary
  say "Done. Next: $( [ "$phase" = A ] && echo 'give the Windows agent device-results/DEPLOYED-FINAL-*.md, then run: bash scripts/release.sh --phase B' || echo 'the manual items above' )"
}

if [ "${RELEASE_SOURCE_ONLY:-0}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi
main "$@"

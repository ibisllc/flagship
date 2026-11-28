#!/usr/bin/env bash
#
# release.sh: take current origin/main to a full production release, by hand.
#
# The owner runs this from a terminal. It walks docs/runbooks/final-deploy.md
# step by step in two phases (every step in --list is one this release runs;
# one-time setup that already happened is a read-only check, not a step), asks before every command that changes anything
# outside the local checkout, and never reads, echoes or stores a secret:
# wrangler, flyctl, gh and the Apple tools prompt or use their own login, the
# YubiKey tools read their PIN from /dev/tty, and FLAGSHIP_ADMIN_SECRET comes
# only from a silent prompt (kept in memory, handed to the child processes that
# need it, unset on exit).
#
#   bash scripts/release.sh --phase A      sign, gate and deploy (.com, the relay, the appliances)
#   bash scripts/release.sh --phase B      the canary, the notice, the reap, the Studios, the stores
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
COM_URL="https://flagshipserver.com"
SERVICES_URL="https://flagship.services"
WEBAPP_URL="https://webapp.flagshipserver.com"
REMOTE_URL="https://remote.flagshipserver.com"
BOOT_URL="https://boot.flagshipserver.com"
SHIM_URL="https://inference.flagshipserver.com"
# The relay mesh at launch (owner, 2026-11-03): ONE relay, iad1, kind full, on ONE machine of the existing Fly app.
RELAY_APP="flagship-services"
MESH_RELAY_ID="iad1"
MESH_RELAY_REGION="iad"
MESH_TUNNEL_HOST="tunnel.flagship.services"
MESH_RELAY_HOST="$MESH_RELAY_ID.$MESH_TUNNEL_HOST"
MESH_HUB_URL="wss://$MESH_TUNNEL_HOST:8443/tunnel"
LEGACY_HUB_URL="wss://flagship-services.fly.dev:8443/tunnel"
FEED_URL="https://feed.flagshipserver.com/v1"
MESH_SEED_FILE="${FLAGSHIP_RELAY_SEED_FILE:-$HOME/.config/flagship/$MESH_RELAY_ID.seed}"
export PATH="$HOME/.fly/bin:$PATH"

DRY=0
PIN=""
CURRENT_STEP=""
PROBE_FAILS=0
ADMIN_SECRET="${FLAGSHIP_ADMIN_SECRET:-}"
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

# One tiny node helper owns the JSON file (atomic write, mode 600). Steps are recorded by id (plan 2). A state
# file of the 48-step plan (0.3, 0.4's first run) recorded step numbers: they are read through LEGACY, and the
# file is rewritten by id at its next write; the one-time steps folded into "setup" count as it when all were done.
ST_JS='
const fs=require("fs"),path=require("path");
const [f,op,k,v]=process.argv.slice(1);
let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
const LEGACY="preflight version plan lease catalogkeys pqkeys endorse artifacts catalog runtime shellsig kickoff secrets gym backup r2buckets feeddomain meshseed migrations services dnsbroker dns com relaykey relayadmit meshcerts meshon meshrelay meshwatch cpu publish redeployA status canary notice scrub reap retire studiowl studiomac publisharm redeployB uxchecks ios android upgradenotice hof final".split(" ");
if(s.planVersion!==2&&Object.keys(s).length){
 for(const key of ["done","skipped"])if(Array.isArray(s[key]))s[key]=[...new Set(s[key].map(x=>/^[0-9]+$/.test(x)&&LEGACY[x-1]?LEGACY[x-1]:x))];
 const d=s.done||[];if(["catalogkeys","pqkeys","backup","r2buckets","feeddomain","meshseed","dns"].every(x=>d.includes(x))&&!d.includes("setup"))d.push("setup");
}
const w=()=>{s.planVersion=2;fs.mkdirSync(path.dirname(f),{recursive:true});const t=f+".tmp";fs.writeFileSync(t,JSON.stringify(s,null,2)+"\n",{mode:0o600});fs.renameSync(t,f)};
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

STEP_IDS=(preflight version plan setup lease endorse artifacts catalog runtime shellsig kickoff secrets gym migrations dnsbroker com
          meshcheck meshrelay cpu publish status
          canary notice reap studiowl studiomac redeployB storeart ios android upgradenotice final)
LAST_A=21   # the last step of phase A (status)

step_id()    { echo "${STEP_IDS[$(($1 - 1))]}"; }
step_count() { echo "${#STEP_IDS[@]}"; }
step_phase() { if [ "$1" -le "$LAST_A" ]; then echo A; else echo B; fi; }
phase_first() { if [ "$1" = A ]; then echo 1; else echo $((LAST_A + 1)); fi; }
phase_last()  { if [ "$1" = A ]; then echo "$LAST_A"; else step_count; fi; }

TITLE=""; WHAT=""; RUNBOOK=""; CMDS=""; GATE=""; ROLLBACK=""; REQUIRED=0; OUTWARD=1

meta_version() {
  TITLE="Bump the product version (one version on every surface), and open name dibs on release day"
  RUNBOOK="0b. Bump the product version"
  WHAT="Asks for the new product version (a release branch usually carries the bump already: answer keep) and the store numbers, which must climb, writes release/version.json, regenerates every surface's copy with check-versions --write, commits and pushes to main, then re-pins. A run that keeps the version skips it."
  read -r -d '' CMDS <<'EOF' || true
cat release/version.json                  (product, label, iosVersion, iosBuild, androidVersionCode, studio)
(edit release/version.json with your answers)
node scripts/check-versions.mjs --write
node scripts/check-versions.mjs
git add -- <files check-versions wrote> && git commit -m "Bump the product version to <v>"
git push origin HEAD:main            (then the pin moves to this commit)
EOF
  GATE="check-versions passes; the version commit is on origin/main and pinned."
  ROLLBACK="Revert the commit on main before anything is built from it; store numbers already uploaded are burned (take the next ones)."
}
meta_artifacts() {
  TITLE="Build, sign and publish the box artifacts (+ gVisor mirror, box release, pins)"
  RUNBOOK="3b. Build, sign and publish the box artifacts"
  REQUIRED=1
  WHAT="Every new server installs the signed artifact for one exact commit (SEC-INSTALL-001). Dispatches box-artifact.yml for the pinned commit with a sequence above the last, downloads both architectures, signs each manifest with the YubiKey, verifies it against release/box-artifact-trust.json, uploads artifacts and manifests to R2 flagship-iso with releases.json, makes sure the gVisor mirror is there, points release/box-release.json at the commit, regenerates the compiled constants, re-pins the bootstrap hash the TS and Swift builders share, commits and pushes, then re-pins."
  read -r -d '' CMDS <<'EOF' || true
gh workflow run box-artifact.yml --ref main -f commit=<PIN> -f sequence=<N> ; gh run watch <id> --exit-status
gh run download <id> -D ~/flagship-release-artifacts/box-<pin>
npx tsx tools/box-artifact/build.ts sign --manifest <m> --out <m> --signer-cmd "node scripts/yubikey-sign.mjs"     (YubiKey PIN + touch, per architecture)
npx tsx tools/box-artifact/build.ts verify --manifest <m> --artifact <tar.gz> --commit <PIN> --arch <arch>
npx tsx tools/box-artifact/release-index.ts <dir>
(cd apps/com && wrangler r2 object put flagship-iso/<file> --file <file> --remote)      (artifacts, manifests, releases.json)
bash scripts/publish-gvisor-mirror.sh --skip-if-at https://flagshipserver.com/build/iso
(release/box-release.json: commit <PIN>, sequence <N>) ; node scripts/gen-box-release.mjs --write
node scripts/repin-bootstrap-sha.mjs --write
git add -- release packages apps && git commit -m "Install box release <pin> (sequence <N>)" && git push origin HEAD:main
EOF
  GATE="Both manifests verify against the trust file; curl -fsSI https://flagshipserver.com/build/iso/flagship-box-<pin12>-amd64.manifest.json answers 200; gen-box-release --check and the bootstrap pin test pass; the box release commit is on origin/main."
  ROLLBACK="Nothing installs an artifact until the box release commit deploys with .com: revert that commit to keep new servers on the previous release. A published artifact is harmless; never reuse its sequence."
}
meta_catalog() {
  TITLE="Sign and publish the release catalog for this release"
  RUNBOOK="3c. Sign and publish the release catalog"
  WHAT="Skipped when no catalog root is pinned. Adds this release to release/catalog-releases.json (security version, rollout share), signs targets and snapshot with the offline root key and the timestamp with the timestamp key, checks it the way a box does, uploads catalog-{targets,snapshot,timestamp}.json to R2, commits the list and re-pins. The daily workflow keeps the timestamp fresh from then on."
  read -r -d '' CMDS <<'EOF' || true
curl -fsS https://flagshipserver.com/build/iso/catalog-timestamp.json -o <tmp>/previous.json        (absent on the first release)
npx tsx tools/release-catalog/catalog.ts sign --root release/catalog-root.json --releases <list> --version <V> --floor <F> --key <offline>/catalog-root-1.key.json --timestamp-key <offline>/catalog-timestamp-1.key.json [--previous-timestamp <tmp>/previous.json] --out-dir <out>
(cd apps/com && wrangler r2 object put flagship-iso/catalog-<name>.json --file <out>/<name>.json --remote)    (targets, snapshot, timestamp)
gh workflow run release-catalog-timestamp.yml --ref main ; gh run watch <id> --exit-status
git add -- release/catalog-releases.json && git commit -m "Release catalog v<V>" && git push origin HEAD:main
EOF
  GATE="The tool's own check passed; the timestamp workflow is green; the served catalog-targets.json names this release."
  ROLLBACK="Publish a newer targets version without the release (or with rolloutPercent 0); versions only go up. A floor raised by mistake cannot be lowered: boxes refuse rollbacks below it until a newer release ships."
}
meta_runtime() {
  TITLE="Sign and commit the runtime manifest (YubiKey), so .com serves it at /api/runtime/manifest and /runtime"
  RUNBOOK="3d. Sign and commit the runtime manifest"
  REQUIRED=1
  WHAT="Builds the signed runtime manifest (flagship/runtime-manifest/v1 + its PQ companion) from release/runtime-lock.json with the next sequence above the committed release/runtime-manifest.json and this release's product version, previews it, signs it on your yes with the YubiKey (Ed25519 through scripts/yubikey-sign.mjs, then the PQ companion with the release ML-DSA key), checks it against release/box-artifact-trust.json and the committed lock, writes release/runtime-manifest.json, commits and pushes to main, then re-pins. The .com deploy step then serves it; until then boxes and apps show 'not published'. Boxes hand it to the updater, which refuses an update whose runtime lock it does not accept; an absent or expired manifest never stops a box (the artifact's signed lock decides). It is valid 45 days: re-sign (bash scripts/release.sh --only <this step>, or the same commands) and deploy .com before it ends."
  read -r -d '' CMDS <<'EOF' || true
npx tsx tools/box-artifact/runtime-manifest.ts release                    (preview: no signature, no write)
npx tsx tools/box-artifact/runtime-manifest.ts release --sign --pq-key-file ~/.flagship-release/pq-release-key.age     (YubiKey PIN + touch, twice)
npx tsx tools/box-artifact/runtime-manifest.ts verify --manifest release/runtime-manifest.json
git add -- release/runtime-manifest.json && git commit -m "Runtime manifest: node <version>, sequence <N>"
git push origin HEAD:main            (then the pin moves to this commit; .com serves it once the .com step deploys)
EOF
  GATE="verify prints 'verified: node <lock version> sequence <N>'; the commit is on origin/main and pinned. After the .com deploy: curl -fsS https://flagshipserver.com/api/runtime/manifest answers 200 with that sequence."
  ROLLBACK="Before the .com deploy: revert the commit. After: a signed manifest cannot be taken back; sign a newer sequence (boxes refuse a lower one). Committing null again makes .com answer 204; boxes keep the last one they accepted, and updates fall back to the artifact's signed lock."
}
meta_shellsig() {
  TITLE="Sign the webapp shell (YubiKey), so the webapp can prove it is the release"
  RUNBOOK="3e. Sign the webapp shell"
  WHAT="The webapp checks /shell-signature.json against the ca-track authority (docs/webapp-key-custody.md, 'Signing a release shell'). Builds the webapp assets exactly as the deploy does, previews the shell version, file count and manifest digest, then on your yes signs flagship/webapp-shell/v1 with the ca-track YubiKey and the release key's PQ half, writes release/webapp-shell/<version>.json, commits and pushes to main and re-pins. The .com deploy copies it to /shell-signature.json only when it signs exactly that build, so any later shell change needs this step again. Skipped when the shell is already signed. Once a signed shell is live, SHELL_SIGNATURE_REQUIRED = true in lib/shellTrust.js is its own shell change: bump the shell, run this step again, redeploy (the 0.4 deploy sheet). A re-pin re-opens this step when the webapp shell version moved."
  read -r -d '' CMDS <<'EOF2' || true
grep 'const SHELL_VERSION' apps/web/public/webapp/service-worker.js        (the version to sign)
npx tsx scripts/webapp-shell.ts sign                                     (preview: no signature, no write)
npx tsx scripts/webapp-shell.ts sign --sign --key-file ~/.flagship-release/pq-release-key.age     (YubiKey PIN + touch, twice)
git add -- release/webapp-shell/<version>.json && git commit -m "Sign webapp shell <version>"
git push origin HEAD:main            (then the pin moves to this commit; the .com deploy publishes it)
EOF2
  GATE="release/webapp-shell/<version>.json is on origin/main and pinned. After the .com deploy: https://webapp.flagshipserver.com/shell-signature.json answers 200 naming that version."
  ROLLBACK="Before the deploy: revert the commit. After: the old shell keeps working; a signature cannot be taken back, so a bad shell gets a newer version, signed again."
}
meta_canary() {
  TITLE="Canary cohorts: widen the box release on update receipts, stop it on bad news"
  RUNBOOK="9b. Canary cohorts"
  WHAT="Skipped when no catalog root is pinned. Existing boxes take this release only inside its rollout percent (each box's own secret salt decides its cohort). Reads the content-free update receipts of consenting boxes (npm run canary) for the release and its stage: STOP signs and publishes the release at 0% (the stop rule) and ends the run; HOLD (one rollback) asks for a typed reason before widening; WAIT defers the step (resume with --only); WIDEN signs the next stage of 1, 5, 20, 50, 100 with the offline keys, publishes it and records when the stage opened. Done at 100%."
  read -r -d '' CMDS <<'EOF' || true
npm run canary -- --release <commit> --opened-at <when this stage opened>
curl -fsS https://flagshipserver.com/build/iso/catalog-{targets,timestamp}.json        (the served catalog: the new one must move past it)
npx tsx tools/release-catalog/catalog.ts rollout --root release/catalog-root.json --list release/catalog-releases.json --commit <commit> --percent <next stage> --key <offline>/catalog-root-1.key.json --timestamp-key <offline>/catalog-timestamp-1.key.json --previous-targets <served targets> --previous-timestamp <served timestamp> --out-dir <out>
(cd apps/com && wrangler r2 object put flagship-iso/catalog-<name>.json --file <out>/<name>.json --remote)    (targets, snapshot, timestamp)
git add -- release/catalog-releases.json && git commit -m "Canary: <commit> to <N>%" && git push origin HEAD:main
STOP:  the same rollout command with --percent 0 (or --remove), the same upload and commit
EOF
  GATE="Each widening: the stage open at least 48 h (more for boot or driver changes), at least 3 receipts, no rollback in any profile (one holds the canary for a look, two stop it), no box stuck below the floor. The first widening also needs this release's gym run green for the update and canary groups and one deliberate rollback drill receipt (docs/runbooks/canary.md). Deferred until 100%."
  ROLLBACK="The stop rule: rollout --percent 0 (or --remove) signed and published; boxes take nothing new from it. Boxes that already updated keep it: ship a fixed release with a higher security version. Prefer --percent 0 to --remove when a floor is set (a removed release is no longer a rollback target)."
}
meta_dnsbroker() {
  TITLE="Deploy the DNS broker (before .com)"
  RUNBOOK="7a. Deploy the DNS broker"
  WHAT="The broker is the only holder of the zone-wide Cloudflare DNS token: .com's issuance service writes its _acme-challenge TXT records through it (POST /service, apps/dns-broker/src/service.ts) and holds no token itself. Skipped while apps/com/wrangler.toml sets no DNS_BROKER_URL (then .com still uses its own CLOUDFLARE_DNS_API_TOKEN). Otherwise checks the broker's secrets (CLOUDFLARE_DNS_API_TOKEN, DNS_BROKER_SECRET), deploys apps/dns-broker and checks /service answers 401 without the secret."
  read -r -d '' CMDS <<'EOF' || true
grep '^DNS_BROKER_URL' apps/com/wrangler.toml      (unset: step skipped)
(cd apps/dns-broker && npx wrangler secret list)   (CLOUDFLARE_DNS_API_TOKEN, DNS_BROKER_SECRET)
(cd apps/dns-broker && npm run deploy)
curl -s -o /dev/null -w '%{http_code}' -X POST <DNS_BROKER_URL>/service   (401)
EOF
  GATE="Skipped with no DNS_BROKER_URL; else the deployment is listed and /service answers 401 without the secret. After the .com deploy, a certificate order reaches issued (its challenge records went through the broker)."
  ROLLBACK="npx wrangler rollback in apps/dns-broker. To take .com off the broker: remove DNS_BROKER_URL from apps/com/wrangler.toml, put CLOUDFLARE_DNS_API_TOKEN back on flagship-com, redeploy .com."
}
meta_storeart() {
  TITLE="Store art: the release check before the store builds (and the translations' review status)"
  RUNBOOK="11c. Store art and the translations' review status"
  OUTWARD=0
  WHAT="Runs npm run store-assets:release-check on the native captures (docs/store-assets/capture-plan.md; the git-ignored captures are copied in from your checkout) right before the store builds. When captures are missing you may go on with the screenshots the stores already have (typed keep-current-art). Also prints how many lines of i18n/REVIEW.md still wait for a native reader: a status, not a gate (the translation gate, npm run i18n, runs in preflight and on every merge)."
  read -r -d '' CMDS <<'EOF' || true
npm run store-assets:release-check        (the native captures, docs/store-assets/capture-plan.md)
grep -c '^- \[ \]' i18n/REVIEW.md          (lines still waiting for a native reader: status only)
EOF
  GATE="The store-art check passes, or you typed keep-current-art (the stores keep their screenshots)."
  ROLLBACK="Nothing ships from this step."
}
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
npm run i18n
npx vitest run <touched packages>   (quick)   or   npx vitest run   (full)
EOF
  GATE="Every command above exits 0; the tool versions print; both logins show the right accounts."
  ROLLBACK="Nothing changes outside the local worktree."
}
meta_plan() {
  TITLE="Cloudflare plan and DNS limits (acknowledge)"
  RUNBOOK="1. Cloudflare plan and DNS limits (do this first)"
  OUTWARD=0
  WHAT="Records which Workers plan .com runs on (Paid since 2026-10-20) and prints the limits and the signals to watch."
  read -r -d '' CMDS <<'EOF' || true
(no command: a typed answer, free or paid)
open https://dash.cloudflare.com -> Workers & Pages -> flagship-com -> Settings (shows the plan)
EOF
  GATE="You typed free or paid; on Free you accept the 10 ms CPU, 100,000 requests a day and 50 subrequests limits."
  ROLLBACK="A plan change is reversible in the dashboard."
}
meta_setup() {
  TITLE="One-time setup still in place (read-only: catalog root, PQ key, D1 backup, R2 buckets, relay feed, mesh key, root wildcard)"
  RUNBOOK="1f. One-time setup still in place (checked every release)"
  OUTWARD=0
  WHAT="Read-only and quiet while everything holds (one ok line each, no prompt): the release catalog root (2b) and the PQ release key (2c) are pinned; the daily D1 backup works (the repo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, a real age recipient, the d1/daily/ rule on flagship-d1-backups, latest.json under 36 hours old: 1b), the net under the migrations; every R2 bucket the pinned apps/com/wrangler.toml binds exists (1c: a bucket new in this release is offered for creation, the .com deploy fails without it); feed.flagshipserver.com answers over valid TLS (1d); .com holds RELAY_MESH_KEY_SEED and SERVING_REVOCATION_SEED (1e); the flagship.services root wildcard answers the relay's two addresses and the apex CAA names Let's Encrypt (6a). A failed line names the runbook section that sets it up again, and the step fails until it holds."
  read -r -d '' CMDS <<'EOF' || true
test -f release/catalog-root.json ; (release/box-artifact-trust.json names a PQ key)
gh secret list                                   (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
grep age1 .maintainers/backup-recipient.pub
(cd apps/com && wrangler r2 bucket lifecycle list flagship-d1-backups)        (the d1/daily/ rule)
(cd apps/com && wrangler r2 object get flagship-d1-backups/latest.json --file <tmp> --remote)   (taken in the last 36 hours)
grep '^bucket_name' apps/com/wrangler.toml ; (cd apps/com && wrangler r2 bucket list)   (a missing one, on your yes: wrangler r2 bucket create <name>)
curl -sI https://feed.flagshipserver.com/v1/head.json                        (valid TLS)
(cd apps/com && wrangler secret list)            (RELAY_MESH_KEY_SEED, SERVING_REVOCATION_SEED)
dig +short A anything-at-all.flagship.services @1.1.1.1 ; dig +short AAAA anything-at-all.flagship.services @1.1.1.1
dig +short CAA flagship.services @1.1.1.1
EOF
  GATE="Every line ok."
  ROLLBACK="Read-only (a bucket it creates on your yes is empty and harmless)."
}
meta_lease() {
  TITLE="CA lease: check the expiry, renew with the YubiKey"
  RUNBOOK="2. Renew the CA lease (before anything that needs the CA)"
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
git add -- .maintainers/endorsements .maintainers/release-pq/endorsements && git commit -m "Endorse <sha> on the ca track"
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
gh workflow run vm-appliance.yml --ref main -f arch=amd64 -f git_ref=main -f release=box-release
gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=box-release
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
  TITLE="Gym gate: every live group green on this commit, on both stacks"
  RUNBOOK="6. Gym refresh and live verification (GATE: nothing deploys to prod until this passes)"
  REQUIRED=1
  OUTWARD=1
  WHAT="Runs scripts/gym-release-run.sh: refreshes the gym onto this commit, takes the gym lock, runs every live group on both container stacks, tears the fleet down. It reads the gym secrets from your checkout's .gym-secrets.env (this script passes the path; no prefix needed). Exit 0 = go, 3 = skips you must accept, 5 = build new boxes on classic, 6 = only the policed browser failed: ship it off (appBrowser false), anything else = no-go. Then the DNS canary and the two health URLs."
  read -r -d '' CMDS <<'EOF' || true
bash scripts/gym-release-run.sh          (GYM_START_REF=origin/gym-ux to run a UX branch's gym)
npx tsx tools/live-e2e/dns-ent-experiment.ts --canary
EOF
  GATE="gym-release-run.sh exits 0 (or 3 and you type accept-skips), then you type verified"
  ROLLBACK="No-go blocks the prod deploys: fix on main, run this step again."
}
meta_migrations() {
  TITLE="Pending D1 migrations (check, apply, stamp the ledger)"
  RUNBOOK="4. Pending D1 migrations"
  WHAT="Compares packages/storage/migrations with the prod schema_version ledger (read-only) and applies each pending file after its own confirm, in file order. For 0.4 that is 0090, 0091, 0093, 0094 (the folded marketplace and name-change tables), 0133, 0134, 0136-0138, 0141, 0146-0158 (and 0132 if the ledger lacks it): all before the .com deploy (npm run deploy refuses while one is missing). The setup check (step 4) proved the daily backup is fresh."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && wrangler d1 execute flagship-state --remote --json --command "SELECT version FROM schema_version")
for each pending file, in order:
  (cd apps/com && wrangler d1 execute flagship-state --remote --file=../../packages/storage/migrations/<file>)
  (cd apps/com && wrangler d1 execute flagship-state --remote --command "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES ('<NNNN>', <ms>)")
EOF
  GATE="A second read of the ledger lists every repo migration."
  ROLLBACK="There are no down-migrations: roll the code back, leave additive tables, forward-fix. Data damage: docs/runbooks/d1-restore.md."
}
meta_meshcheck() {
  TITLE="Relay mesh: check (iad1 in the feed directory, its Fly secrets, both tunnel names on valid TLS)"
  RUNBOOK="8. The relay: the mesh check, the Rust relay deploy and the mesh-off rollback"
  OUTWARD=0
  WHAT="Read-only. The mesh was set up once in 0.3 (runbook 8a-8d: the iad1 relay key, its admission, the tunnel certificates and DNS, the feed switched on). This checks it still holds before the relay deploy: the live feed directory lists iad1; flagship-services holds FLAGSHIP_RELAY_KEY_SEED, SERVICES_CONTROL_SECRET and .com's relay-log key (FLAGSHIP_RELAY_LOG_PUB or FLAGSHIP_SERVING_REVOCATION_PUB); iad1.tunnel.flagship.services and tunnel.flagship.services answer /api/health on :8443 over valid TLS; the pinned apps/com/wrangler.toml keeps RELAY_MESH on and TUNNEL_HUB_URL at tunnel.flagship.services. A failed line names the 8a-8d section that sets it up again."
  read -r -d '' CMDS <<'EOF' || true
curl -s https://feed.flagshipserver.com/v1/directory.json | jq '[.directory.relays[].relayId]'     (iad1)
flyctl secrets list -a flagship-services --json       (FLAGSHIP_RELAY_KEY_SEED, SERVICES_CONTROL_SECRET, FLAGSHIP_RELAY_LOG_PUB)
curl -s -o /dev/null -w "%{http_code}" https://iad1.tunnel.flagship.services:8443/api/health     (200, valid TLS)
curl -s -o /dev/null -w "%{http_code}" https://tunnel.flagship.services:8443/api/health
grep -E '^(RELAY_MESH|TUNNEL_HUB_URL) = ' apps/com/wrangler.toml
EOF
  GATE="Every line ok."
  ROLLBACK="Read-only."
}
meta_meshrelay() {
  TITLE="Relay: deploy the Rust relay as iad1 (fly.relay.mesh.toml, ONE machine; every tunnel drops ~20-60 s), then the 30-minute watch"
  RUNBOOK="8e. Relay mesh: deploy the Rust relay as iad1"
  REQUIRED=1
  WHAT="The relay update of every release (quiet hours). Takes a tunnel-count baseline, keeps flagship-services at ONE machine (one relay id = one machine), then deploys fly.relay.mesh.toml (Dockerfile.relay, FLAGSHIP_MESH=on, iad1, full, feed.flagshipserver.com) rolling: the only machine stops and starts, every box redials. Then: health 200 and mesh-ready, live-check --expect rust on both names (health + the :8444 echo), npm run ops -- mesh, the relay echo on the dedicated address, one machine. Then offers the 30-minute watch (once a minute: status, runtime, mesh readiness, tunnel count against the baseline; three failures in a row, a relay that is not Rust, or tunnels below 80% after minute 10 print the rollback); say no to check it later by hand (the health URL and npm run ops -- mesh). The mesh-off TS hub (fly.toml) is a documented rollback, never a step."
  read -r -d '' CMDS <<'EOF' || true
npm run ops -- services                           (baseline: box tunnels online; needs USAGE_REPORT_SECRET in your shell)
flyctl machines list -a flagship-services          (one machine; else flyctl scale count 1 -a flagship-services --yes)
flyctl deploy -c fly.relay.mesh.toml -a flagship-services --remote-only --strategy=rolling --yes
curl -s https://iad1.tunnel.flagship.services:8443/api/health | jq '.runtime, .mesh, .tunnelsOnline'
npx tsx tools/relay-conformance/live-check.ts --relay iad1.tunnel.flagship.services --expect rust
npx tsx tools/relay-conformance/live-check.ts --relay flagship-services.fly.dev --expect rust
npm run ops -- mesh                               (iad1 ready)
openssl s_client -connect 149.248.216.86:8444 -servername flagship-services.fly.dev   (GET /echo names 149.248.216.86)
(on your yes) curl -s https://iad1.tunnel.flagship.services:8443/api/health   every 60 s, 30 times; then npm run ops -- mesh
EOF
  GATE="iad1 answers /api/health 200 with runtime rust and mesh.ready true; both live-checks exit 0; ops -- mesh shows iad1 ready; the echo names the dedicated address; one machine; the watch (when run) ends clean."
  ROLLBACK="Rust -> TS hub, mesh kept: flyctl deploy -c fly.mesh.toml -a flagship-services --remote-only --strategy=rolling --yes (then live-check --expect ts). TS mesh -> mesh off: flyctl deploy -a flagship-services --remote-only --strategy=rolling --yes (fly.toml) and flyctl scale count 2 -a flagship-services --yes. Boxes need nothing (runbook 8f)."
}
meta_com() {
  TITLE="Deploy .com (Cloudflare Worker) and check it"
  RUNBOOK="7. Deploy \`.com\` (two Workers)"
  REQUIRED=1
  WHAT="Runs 'npm run deploy' in apps/com in the foreground of your terminal: the guards, then the NEW static-only Worker flagship-webapp, then flagship-com. The first run moves the webapp. and remote. custom domains and wrangler ASKS to confirm: answer yes. Refuses until the setup check (the D1 backup among it) is recorded, and asks for a typed reason while release/runtime-manifest.json is still null. Any GYM_* variable in your shell is dropped for the deploy (the webapp deploy guard refuses them), so no prefix is needed. Then probes the webapp and remote hosts (200, strict CSP), the tree's shell version, the marketing page, health, notices, account-not-found, the boot route, the shim, and runs zone-health as a post-check."
  read -r -d '' CMDS <<'EOF' || true
(cd apps/com && wrangler deployments list)         (the rollback target)
(cd apps/com && npm run deploy)     (flagship-webapp first, then flagship-com; answer YES to the custom-domain prompt; no pipe, no redirect)
curl -sI https://webapp.flagshipserver.com/ ; curl -sI https://remote.flagshipserver.com/    (200 and a strict content-security-policy)
curl -s -o /dev/null -w "%{http_code}" https://webapp.flagshipserver.com/lib/no-such-file.js (404 from the static-only Worker)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/                          (the marketing page, 200)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/api/health
curl -s https://webapp.flagshipserver.com/service-worker.js | grep "^const SHELL_VERSION"     (equals the tree's)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/api/notices        (204 until a notice is signed)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/api/runtime/manifest   (200 once the runtime step committed it; a null file asks for a typed no-runtime-manifest first)
curl -s -o /dev/null -w "%{http_code}" https://flagshipserver.com/api/users/<unknown>/pods   (404 account-not-found)
curl -s -o /dev/null -w "%{http_code}" https://boot.flagshipserver.com/not-a-route   (404 from the boot host)
curl -s https://inference.flagshipserver.com/healthz                                 (shim; warning only)
curl -sI https://flagshipserver.com/ | grep -i "x-frame-options\|strict-transport"
npm run zone-health                                                                  (post-check: wildcard + CAA lines must be OK; legacy account records are listed until the reap; admin secret)
EOF
  GATE="webapp. and remote. answer 200 with the strict CSP, the live shell version equals the tree's, / answers, health 200, notices 204, the runtime manifest 200, account-not-found 404, boot route 404, framing headers present."
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
meta_publish() {
  TITLE="Publish the VM appliances that are ready (and the USB seed), then redeploy .com so /downloads/ serves them"
  RUNBOOK="9. Publish the VM appliances"
  WHAT="Finds the newest green vm-appliance runs on main built after the endorsement (or waits for the running ones), checks the boot smoke, uploads each arch to R2 and commits the manifests; arm64 (TCG, up to three hours) may be left for the phase B redeploy, which publishes it first. Publishes the phone USB boot seed (reproducible build, GitHub release asset) and switches on FLAGSHIP_ISO_SEED. Then deploys .com with its post-checks and compares each live manifest's sha256 with the published run."
  read -r -d '' CMDS <<'EOF' || true
gh run list --workflow vm-appliance.yml --branch main --status success
gh api repos/{owner}/{repo}/actions/runs/<id>/artifacts       (arch = artifact name)
gh run view <id> --json jobs                                  (the boot smoke step must be success)
bash scripts/publish-vm-appliance.sh <run id>                 (once per arch; uploads parts to R2 flagship-iso/)
git add -- apps/web/public/downloads/FlagshipVMAppliance-<arch>.json && git commit -m "Publish the rebuilt VM appliances"
gh workflow run iso-seed.yml --ref main                       (rebuilds the USB seed and checks the pin; wait for green)
bash scripts/publish-iso-seed.sh <iso-seed run id>            (GitHub release asset + FLAGSHIP_ISO_SEED in apps/com/wrangler.toml)
git add -- apps/com/wrangler.toml && git commit -m "Publish the USB seed"
git push origin HEAD:main
(cd apps/com && npm run deploy)                               (and the .com post-checks)
curl -s https://flagshipserver.com/downloads/FlagshipVMAppliance-<arch>.json | jq .sha256
EOF
  GATE="Each manifest's commit equals release/box-release.json's commit; FLAGSHIP_ISO_SEED is set with the seed's real url and size, its sha256 equals the iso-seed.yml pin; the live manifest sha256 equals the published run's."
  ROLLBACK="Re-point the manifest at the previous commit and redeploy .com (old R2 parts stay), or wrangler rollback <version-id> in apps/com."
}
meta_status() {
  TITLE="Optional: DEPLOYED-FINAL status for a planned device test (on its own device-results branch)"
  RUNBOOK="9. Publish the VM appliances"
  WHAT="Only when a device test (the Windows agent, hardware) is planned against this deploy: asks, and with no test planned writes nothing. Otherwise writes DEPLOYED-FINAL-<date>.md (main sha, endorsed release, shell version, DNS design, appliances with sha256, what is live), prints it, and on your yes commits it to device-results/<machine>-<date> from a temporary worktree: the branch is created from main when it does not exist yet."
  read -r -d '' CMDS <<'EOF' || true
(typed: is a device test planned? Enter = no, nothing written)
git worktree add --detach <tmp> origin/device-results/<machine>-<date>      (or origin/main for a new branch)
cp DEPLOYED-FINAL-<date>.md <tmp>/device-results/ && git add -- device-results/DEPLOYED-FINAL-<date>.md && git commit
git push origin HEAD:refs/heads/device-results/<machine>-<date>        (fast-forward or a new branch)
EOF
  GATE="No device test planned, or the push is a fast-forward (or creates the branch); main is not touched."
  ROLLBACK="Revert the commit on the device-results branch; it is a status note."
}
meta_notice() {
  TITLE="Maintenance notice (optional: preview, you sign it)"
  RUNBOOK="12. The maintenance notice and the reap"
  WHAT="Only when maintenance with visible downtime is planned (Enter = no notice): previews the maintainer-signed notice the apps show as a banner; you sign it in another terminal (YubiKey), then this step commits it, pushes and redeploys .com."
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
meta_reap() {
  TITLE="Reap orphaned DNS records and demo servers, then zone-health"
  RUNBOOK="12. The maintenance notice and the reap"
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
meta_studiowl() {
  TITLE="Studio for Windows and Linux: public GitHub release + download URLs"
  RUNBOOK="10. Studio releases (Mac, Windows, Linux)"
  WHAT="Dispatches studio-release.yml with publish=true (skipped when the release for this Studio version exists), waits for it, checks the Windows zip and Linux AppImage names, points INSTALLER_DOWNLOADS in apps/com/src/route.ts (and its test) at the new asset names, tests, pushes. No Studio carries a maturity tag (owner, 2026-11-20)."
  read -r -d '' CMDS <<'EOF' || true
gh workflow run studio-release.yml --ref main -f publish=true
gh run watch <id> --exit-status
gh release view studio-v<studio version> --json assets
node -e '<rewrite the studio-v<old> URLs in apps/com/src/route.ts and apps/com/test/route.test.ts>'
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
meta_redeployB() {
  TITLE="Redeploy .com with everything pushed in phase B"
  RUNBOOK="7. Deploy \`.com\` (two Workers)"
  WHAT="Publishes the arm64 VM appliance first when the publish step left it pending, applies any D1 migration that landed since the migrations step, then one deploy that carries everything pushed in phase B (the notice, the Studio download URLs, the DMG, the arm64 manifest), with the post-checks and the download redirects."
  read -r -d '' CMDS <<'EOF' || true
(only if arm64 is still pending) bash scripts/publish-vm-appliance.sh <arm64 run id> ; git commit ; git push origin HEAD:main
(cd apps/com && wrangler d1 execute flagship-state --remote --json --command "SELECT version FROM schema_version")   (and any pending file)
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
ver_field() { node -p "require('$REPO/release/version.json').$1" 2>/dev/null || echo "?"; }
meta_upgradenotice() {
  TITLE="Tell older apps to update (optional signed notice, once the stores carry iOS $(ver_field iosVersion) ($(ver_field iosBuild)) and Android $(ver_field androidVersionCode))"
  RUNBOOK="11d. Tell older apps to update"
  WHAT="Only when this release leaves older apps unable to work (Enter = no notice). Run it (--only) once App Store and Google Play have approved this release's builds: previews an update-required notice naming the new store builds (from release/version.json) and the live webapp shell, with an advisory id and the one-sentence reason you give; you sign it with the YubiKey in another terminal, then it commits, pushes and redeploys .com. Older store apps show a banner with an Update button on every launch (their release builds never lock); an older webapp shell locks until its Update button loads the new one."
  read -r -d '' CMDS <<'EOF' || true
node scripts/security-notice.mjs required --message "<text>" --event <approval time> --lock-at <time> --platform ios:<iosBuild> --platform android:<androidVersionCode> --platform web:<shell> --advisory <id> --security-reason "<one sentence>"     (preview)
(you, in another terminal: the same command with --sign)
git add -- .maintainers/notices && git commit -m "Notice: apps before <product> must update" && git push origin HEAD:main
(cd apps/com && npm run deploy)
curl -s https://flagshipserver.com/api/notices
EOF
  GATE="No notice needed, or: both stores list this release's builds; /api/notices returns the notice; an older phone shows the update banner."
  ROLLBACK="node scripts/security-notice.mjs clear --sign (with --supersede-lock while the lock is in force), commit, deploy."
}
meta_final() {
  TITLE="Final verification and the closing summary"
  RUNBOOK="13. What should block GA"
  OUTWARD=0
  WHAT="Re-probes everything that is live, compares the endorsed release with box-code changes on main, and prints the sha, versions, URLs and what is still manual."
  read -r -d '' CMDS <<'EOF' || true
curl health: .com, .services, status page, shell version, notices, downloads, mirror-dns, zone-health, schema-status (admin secret)
npm run rate-limits -- --days 30                 (read-only, admin secret: the weekly budget check, AGENTS.md)
npm run release-manifest
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

mirror_dns_check() { ( cd "$WT" && node scripts/mirror-dns-check.mjs ); } # read-only: public DNS + HTTPS
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

# apps/com/wrangler.toml on stdin -> every R2 bucket_name it binds, one per line
wrangler_buckets() { sed -n 's/^[[:space:]]*bucket_name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u; }

# wrangler r2 bucket list (text "name: X" lines, or JSON with "name") -> bucket names, one per line
r2_bucket_names() { tr ',{}[]' '\n\n\n\n\n' | sed -n 's/^[[:space:]]*name:[[:space:]]*\([A-Za-z0-9._-]*\)[[:space:]]*$/\1/p; s/.*"name"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]*\)".*/\1/p' | sort -u; }

# names on stdin, $1 = a newline list of present names -> the ones missing from it
names_missing() { local have=$1 n; while IFS= read -r n; do [ -z "$n" ] && continue; printf '%s\n' "$have" | grep -qx "$n" || echo "$n"; done; }

# npm run relays -- list --json on stdin, $1 = relay id -> "<active|retired> <relayKey>", or nothing when not admitted
relay_admitted() {
  node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.exit(0)}
const r=(j.relays||[]).find(x=>x.relayId===process.argv[1]);if(r)console.log((r.retiredAt?"retired":"active")+" "+r.relayKey)})' "$1"
}

# the feed directory.json on stdin, $1 = relay id, $2 = relay key (may be empty) -> exit 0 when the directory lists it
directory_lists() {
  node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.exit(1)}
const d=j.directory||j;const r=(d.relays||[]).find(x=>x.relayId===process.argv[1]);
process.exit(r&&(!process.argv[2]||r.relayKey===process.argv[2])?0:1)})' "$1" "${2:-}"
}

# a relay's /api/health body on stdin -> "<runtime> <ready|not-ready|no-mesh> <tunnelsOnline|-> <reasons>"
health_line() {
  node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let h={};try{h=JSON.parse(s)}catch{}
const rt=h.runtime==="rust"?"rust":(h.nodeVersion?"ts":"unknown");
const m=h.mesh;const ready=m?(m.ready?"ready":"not-ready"):"no-mesh";
const why=m?[].concat(m.readiness||m.reasons||[]).map(String).join(",").replace(/\s+/g,"_"):"";
const t=typeof h.tunnelsOnline==="number"?h.tunnelsOnline:"-";
console.log([rt,ready,t,why].filter((x,i)=>i<3||x).join(" "))})'
}

# $1 = tunnels now, $2 = baseline (may be empty), $3 = peak seen -> exit 0 when now >= 80% of max(baseline, peak)
tunnels_ok() { node -e 'const [n,b,p]=process.argv.slice(1).map(x=>Number(x)||0);process.exit(n>=0.8*Math.max(b,p)?0:1)' "$1" "${2:-0}" "${3:-0}"; }

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
  { git -C "$REPO" log --oneline --no-decorate "$PIN..$cur" 2>/dev/null || true; } | head -25 | sed 's/^/  /' || true
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
    repin_reopen
    return 0
  fi
  fail "stopped: origin/main moved. Re-run to re-pin, or land nothing until the release is done."
}

# What a re-pin re-opens (also printed by --list): the webapp shell signature signs one exact shell, so a pin whose
# shell version has no release/webapp-shell/<v>.json needs that step again (then a .com deploy). Every other done
# step stays done; the gym gate only warns at the deploys.
repin_reopen() {
  local v; v=$(git -C "$REPO" show "$PIN:apps/web/public/webapp/service-worker.js" 2>/dev/null | sed -n 's/^const SHELL_VERSION *= *"\(v[0-9]*\)".*/\1/p' | head -1)
  [ -n "$v" ] || return 0
  if st_has done shellsig && ! git -C "$REPO" cat-file -e "$PIN:release/webapp-shell/$v.json" 2>/dev/null; then
    st_w del done shellsig
    warn "the webapp shell moved to $v, which is not signed: step $(step_index shellsig) is open again (bash scripts/release.sh --only $(step_index shellsig), then a .com deploy)"
  fi
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
  # yubikey-sign.mjs prints its signature but never exits (the PC/SC context keeps Node alive), so every
  # caller waited forever: end it once it has printed (restored afterwards, so the worktree stays clean).
  local sg="$WT/scripts/yubikey-sign.mjs"
  if [ -f "$sg" ] && ! grep -q '^process.exit(0);$' "$sg"; then printf '\nprocess.exit(0);\n' >> "$sg"; fi
  local rc=0
  "$@" || rc=$?
  git -C "$WT" checkout -q -- scripts/yubikey-sign.mjs 2>/dev/null || true
  rm -f "$WT/maintainers"
  return $rc
}

require_done() { # require_done id...  (warn and ask when a step this one depends on is not recorded)
  local id
  for id in "$@"; do
    if ! st_has done "$id"; then
      warn "step $(step_index "$id") ($id) is not recorded as done."
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
  # fshp.tech / fshp.app proxied records: no tool writes them and a clean-up once deleted the fshp.tech apex.
  mirror_dns_check || { err "mirror-dns: a proxied fshp.tech / fshp.app record is missing (AGENTS.md \"fshp.tech mirror domain\"): put it back, never delete it"; PROBE_FAILS=$((PROBE_FAILS + 1)); }
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
  # The webapp deploy guard (static-assets.ts) refuses while any GYM_* variable is set: a gym run's environment
  # must never reach the production hostnames. Drop them for the deploy only (0.4 step 23 was refused once).
  ( local v; for v in $(compgen -e | grep -E '^(GYM_|FLAGSHIP_GYM_)' || true); do unset "$v"; done
    XA "$WT/apps/com" npm run deploy
  ) || return 1
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
  WX node scripts/check-carryover.mjs
  WX npm run parity
  WX npm run i18n
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
  say "  .com runs on Workers Paid since 2026-10-20 (owner): no 100,000-a-day hard stop. On Free it would be 10 ms CPU a"
  say "  request, 100,000 requests a day and 50 subrequests a request. Watch the CPU step (step $(step_index cpu)) and"
  say "  npm run ops -- workers --hours 72 after the deploy. The flagship.services zone holds the root wildcard (step $(step_index setup) checks it)."
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
  if pq_pinned; then
    local newest; newest=$(ls -t "$WT/.maintainers/ca-endorsements/"*.json | grep -v bundle.json | head -1)
    say "  PQ companion for the new lease (YubiKey PIN + touch):"
    with_maintainers XA "$WT" node scripts/pq-release-key.mjs sign-ca-lease --endorsement "$newest" --key-file "$PQ_KEY_FILE" --signing-key yubikey-piv:slot=9c --path "$WT/.maintainers"
  fi
  XA "$WT" node scripts/rotate-ca.mjs status
  read -r days na pk < <(lease_days)
  say "  the lease now ends $na ($days days)"
  commit_paths "Renew the production CA lease" .maintainers/ca-endorsements $( [ -d "$WT/.maintainers/ca-pq" ] && echo .maintainers/ca-pq)
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
  commit_paths "Endorse $(short "$endorsed") on the ca track" .maintainers/endorsements $( [ -d "$WT/.maintainers/release-pq/endorsements" ] && echo .maintainers/release-pq/endorsements)
  land_commits || return $?
  st_w set endorsed "$endorsed"
  st_w set endorsedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local now; now=$(latest_endorsed)
  if [ "$now" = "$endorsed" ]; then ok "latest-endorsed-release prints $(short "$now")"; else fail "latest-endorsed-release prints '${now:-nothing}', expected $(short "$endorsed"): a box would not accept this endorsement (a missing PQ companion? node scripts/endorse-release.mjs --pq-only <releaseId> --sign)"; fi
}

set_dibs_window() { # set_dibs_window YYYY-MM-DD: name dibs open that day for six months
  node -e 'const fs=require("fs");const [f,d]=process.argv.slice(1);const s=new Date(d+"T00:00:00Z");if(isNaN(s))process.exit(2);const e=new Date(s);e.setUTCMonth(e.getUTCMonth()+6);let t=fs.readFileSync(f,"utf8");t=t.replace(/DIBS_WINDOW_START = "[^"]*"/,`DIBS_WINDOW_START = "${s.toISOString().slice(0,19)}Z"`).replace(/DIBS_WINDOW_END = "[^"]*"/,`DIBS_WINDOW_END = "${e.toISOString().slice(0,19)}Z"`);fs.writeFileSync(f,t)' "$WT/apps/com/wrangler.toml" "$1"
}

run_version() {
  ensure_wt
  local day; day=$(ask_word "Release day, when name dibs open for six months (YYYY-MM-DD; Enter keeps $(grep -o 'DIBS_WINDOW_START = "[^"]*"' "$WT/apps/com/wrangler.toml" | cut -d'"' -f2))")
  if [ -n "$day" ] && [ "$DRY" != 1 ]; then
    set_dibs_window "$day" || fail "not a date: $day"
    grep -E 'DIBS_WINDOW_(START|END)' "$WT/apps/com/wrangler.toml" | sed 's/^/    /'
    commit_paths "Open name dibs on release day ($day)" apps/com/wrangler.toml
  fi
  local f="$WT/release/version.json" cur
  cur=$(json_field product < "$f")
  say "  now: product $cur ($(json_field label < "$f")), iOS $(json_field iosVersion < "$f") build $(json_field iosBuild < "$f"), Android code $(json_field androidVersionCode < "$f"), Studio $(json_field studio < "$f")"
  local v; v=$(ask_word "New product version (e.g. 0.3), or  keep")
  if [ -z "$v" ] || [ "$v" = keep ] || [ "$v" = "$cur" ]; then
    ok "version unchanged ($cur)"
    if [ -n "$day" ] && [ "$DRY" != 1 ]; then land_commits || return $?; fi
    return 0
  fi
  local label ios build code studio
  label=$(ask_word "Label (now $(json_field label < "$f"); Enter keeps it)"); [ -n "$label" ] || label=$(json_field label < "$f")
  ios=$(ask_word "iOS marketing version (now $(json_field iosVersion < "$f"); must climb)")
  build=$(ask_word "iOS build number (now $(json_field iosBuild < "$f"))")
  code=$(ask_word "Android versionCode (above the highest in Play's App bundle explorer; now $(json_field androidVersionCode < "$f"))")
  studio=$(ask_word "Studio version (now $(json_field studio < "$f"), e.g. ${v}.0)")
  num_ge "$build" "$(( $(json_field iosBuild < "$f") + 1 ))" || fail "the iOS build number must climb"
  num_ge "$code" "$(( $(json_field androidVersionCode < "$f") + 1 ))" || fail "the Android versionCode must climb"
  if [ "$DRY" = 1 ]; then return 0; fi
  node -e 'const fs=require("fs");const [f,v,l,i,b,c,s]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(f,"utf8"));Object.assign(j,{product:v,label:l,iosVersion:i,iosBuild:Number(b),androidVersionCode:Number(c),studio:s});fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$f" "$v" "$label" "$ios" "$build" "$code" "$studio"
  WX node scripts/check-versions.mjs --write
  WX node scripts/check-versions.mjs
  local changed; changed=$(wt_git status --porcelain --untracked-files=no | awk '{print $2}')
  # shellcheck disable=SC2086
  commit_paths "Bump the product version to $v" $changed
  land_commits || return $?
  st_w set productVersion "$v"
}

CATALOG_ROOT_FILE=release/catalog-root.json


PQ_KEY_FILE="${FLAGSHIP_PQ_KEY_FILE:-$HOME/.flagship-release/pq-release-key.age}"
pq_pinned() { node -e 'const t=require(process.argv[1]);process.exit((t.pq?.keyIds?.length??0)>0?0:1)' "$WT/release/box-artifact-trust.json"; }


run_artifacts() {
  ensure_wt
  local last seq; last=$(json_field sequence < "$WT/release/box-release.json")
  say "  box release now: $(json_field commit < "$WT/release/box-release.json" | cut -c1-12), sequence $last"
  seq=$(ask_word "Sequence for $(short "$PIN") (must be above $last)")
  num_ge "$seq" "$((last + 1))" || fail "the sequence must be above $last"
  local run
  if [ -n "${BOX_ARTIFACT_RUN:-}" ]; then
    # Reuse a finished box-artifact run (it must have been dispatched for this commit and this sequence).
    run=$BOX_ARTIFACT_RUN
    confirm "Reuse box-artifact run $run for $(short "$PIN") (sequence $seq) instead of building again?" || return 10
    XA "$REPO" gh run watch "$run" --exit-status
  else
    confirm "Build the box artifacts for $(short "$PIN") (amd64 and arm64) in GitHub Actions now?" || return 10
    XA "$REPO" gh workflow run box-artifact.yml --ref main -f commit="$PIN" -f sequence="$seq"
    [ "$DRY" = 1 ] && return 0
    sleep 8
    run=$(gh run list --workflow box-artifact.yml --limit 1 --json databaseId --jq '.[0].databaseId')
    XA "$REPO" gh run watch "$run" --exit-status
  fi
  local out="$ARTIFACTS/box-$(short "$PIN")" dl; rm -rf "$out"; mkdir -p "$out"; dl=$(mktemp -d)
  XA "$REPO" gh run download "$run" -D "$dl"
  find "$dl" -type f -name 'flagship-box-*' -exec mv {} "$out"/ \;
  rm -rf "$dl"
  local arch name
  for arch in amd64 arm64; do
    name="flagship-box-${PIN:0:12}-$arch"
    [ -f "$out/$name.manifest.unsigned.json" ] && [ -f "$out/$name.tar.gz" ] || fail "the run has no $name artifact"
    say "  sign $name (YubiKey PIN + touch):"
    # The YubiKey signer runs as a direct child of this script (not under npx/tsx, which share the terminal and
    # swallowed the PIN), on the canonical bytes written to a file; build.ts then takes its printed signature.
    local bytes="$out/$name.canonical.bin" sigf="$out/$name.signature.txt"
    ( cd "$WT" && IN="$out/$name.manifest.unsigned.json" OUT="$bytes" npx tsx -e 'import { readFileSync, writeFileSync } from "node:fs"; import { canonicalBoxArtifact } from "./packages/protocol/src/boxArtifact.ts"; writeFileSync(process.env.OUT!, Buffer.from(canonicalBoxArtifact(JSON.parse(readFileSync(process.env.IN!, "utf8")).manifest)));' ) || fail "could not write the canonical bytes of $name"
    with_maintainers XA "$WT" sh -c 'node scripts/yubikey-sign.mjs < "$1" > "$2"' _ "$bytes" "$sigf"
    XA "$WT" npx tsx tools/box-artifact/build.ts sign --manifest "$out/$name.manifest.unsigned.json" --out "$out/$name.manifest.json" --signer-cmd "cat '$sigf'"
    rm -f "$bytes" "$sigf"
    if pq_pinned; then
      say "  PQ companion for $name (YubiKey PIN + touch to open the key):"
      with_maintainers XA "$WT" node scripts/pq-release-key.mjs sign-box-artifact --manifest "$out/$name.manifest.json" --out "$out/$name.manifest.json" --key-file "$PQ_KEY_FILE" --signing-key yubikey-piv:slot=9c
    fi
    XA "$WT" npx tsx tools/box-artifact/build.ts verify --manifest "$out/$name.manifest.json" --artifact "$out/$name.tar.gz" --commit "$PIN" --arch "$arch"
    rm -f "$out/$name.manifest.unsigned.json"
  done
  XA "$WT" npx tsx tools/box-artifact/release-index.ts "$out"
  if curl -fsS -m 25 "$COM_URL/build/iso/releases.json" -o "$out/published-releases.json" 2>/dev/null; then
    node -e 'const fs=require("fs");const [n,o]=process.argv.slice(1);const a=JSON.parse(fs.readFileSync(n,"utf8")).releases,b=JSON.parse(fs.readFileSync(o,"utf8")).releases??[];const by=new Map(b.map(r=>[r.commit,r]));for(const r of a)by.set(r.commit,r);fs.writeFileSync(n,JSON.stringify({releases:[...by.values()].sort((x,y)=>y.sequence-x.sequence)},null,2)+"\n")' "$out/releases.json" "$out/published-releases.json"
    rm -f "$out/published-releases.json"
  fi
  confirm "Upload both artifacts, their manifests and releases.json to R2 flagship-iso?" || return 10
  local f
  for f in "$out"/*; do WRX r2 object put "flagship-iso/$(basename "$f")" --file "$f" --remote; done
  probe_code "amd64 manifest served" "$COM_URL/build/iso/flagship-box-${PIN:0:12}-amd64.manifest.json" 200
  XA "$WT" bash scripts/publish-gvisor-mirror.sh --skip-if-at "$COM_URL/build/iso"
  node -e 'const fs=require("fs");const [f,c,s]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(f,"utf8"));j.commit=c;j.sequence=Number(s);fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$WT/release/box-release.json" "$PIN" "$seq"
  # box-release-regen: the generated constants AND the installer engine bundle Studio and Android ship, its golden
  # vectors and the bootstrap pin (without it new burns installed the previous release).
  WX node scripts/box-release-regen.mjs
  WX node scripts/repin-bootstrap-sha.mjs --write
  WX node scripts/gen-box-release.mjs --check
  local changed; changed=$(wt_git status --porcelain --untracked-files=no | awk '{print $2}')
  # shellcheck disable=SC2086
  commit_paths "Install box release $(short "$PIN") (sequence $seq)" $changed
  st_w set artifactCommit "$PIN"; st_w set artifactSequence "$seq"
  st_w set artifactSha_amd64 "$(json_field manifest.artifactSha256 < "$out/flagship-box-${PIN:0:12}-amd64.manifest.json")"
  land_commits || return $?
  probe_end
}

run_catalog() {
  ensure_wt
  [ -f "$WT/$CATALOG_ROOT_FILE" ] || { ok "no catalog root is pinned: boxes run without the catalog"; return 0; }
  local commit; commit=$(st_get artifactCommit); [ -n "$commit" ] || commit=$(json_field commit < "$WT/release/box-release.json")
  local dir; dir=$(st_get catalogKeyDir); [ -n "$dir" ] || dir=$(ask_word "Offline folder holding catalog-root-1.key.json and catalog-timestamp-1.key.json")
  [ -f "$dir/catalog-root-1.key.json" ] || fail "no root key in $dir"
  local list="$WT/release/catalog-releases.json"
  [ -f "$list" ] || printf '{ "version": 0, "floor": 0, "releases": [] }\n' > "$list"
  local v floor sv pct label
  v=$(( $(json_field version < "$list") + 1 ))
  label=$(json_field product < "$WT/release/version.json")
  sv=$(ask_word "Security version of $(short "$commit") ($label): raise it above every listed release (now highest $(node -e 'const j=require(process.argv[1]);console.log(Math.max(0,...j.releases.map(r=>r.securityVersion)))' "$list"))")
  floor=$(ask_word "Security floor (boxes never roll back below it; now $(json_field floor < "$list"); usually unchanged)")
  pct=$(ask_word "Rollout percent to start at (the canary step widens it along 1, 5, 20, 50, 100; 100 = every box now, no canary)")
  node -e 'const fs=require("fs");const [f,v,fl,c,l,sv,p,sha]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=Number(v);j.floor=Number(fl);j.releases=j.releases.filter(r=>r.commit!==c);j.releases.push({commit:c,label:l,securityVersion:Number(sv),artifactSha256:sha,rolloutPercent:Number(p)});fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' \
    "$list" "$v" "$floor" "$commit" "$label" "$sv" "$pct" "$(st_get artifactSha_amd64)"
  local tmp; tmp=$(mktemp -d); node -e 'const j=require(process.argv[1]);require("fs").writeFileSync(process.argv[2],JSON.stringify(j.releases))' "$list" "$tmp/releases.json"
  local prev=()
  if curl -fsS -m 25 "$COM_URL/build/iso/catalog-timestamp.json" -o "$tmp/previous.json" 2>/dev/null; then prev=(--previous-timestamp "$tmp/previous.json"); fi
  WX npx tsx tools/release-catalog/catalog.ts sign --root "$CATALOG_ROOT_FILE" --releases "$tmp/releases.json" --version "$v" --floor "$floor" \
    --key "$dir/catalog-root-1.key.json" --timestamp-key "$dir/catalog-timestamp-1.key.json" "${prev[@]}" --out-dir "$tmp/out"
  confirm "Upload catalog v$v (targets, snapshot, timestamp) to R2 flagship-iso?" || return 10
  local n
  for n in targets snapshot timestamp; do WRX r2 object put "flagship-iso/catalog-$n.json" --file "$tmp/out/$n.json" --content-type application/json --remote; done
  rm -rf "$tmp"
  probe_code "catalog targets served" "$COM_URL/build/iso/catalog-targets.json" 200
  st_w set canaryOpenedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  XA "$REPO" gh workflow run release-catalog-timestamp.yml --ref main
  commit_paths "Release catalog v$v: $(short "$commit") at security version $sv" release/catalog-releases.json
  land_commits || return $?
  probe_end
}

run_runtime() {
  ensure_wt
  local out; out="$WT/release/runtime-manifest.json"
  say "  Preview (no signature, no write):"
  XA "$WT" npx tsx tools/box-artifact/runtime-manifest.ts release
  confirm "Sign the runtime manifest now? (YubiKey PIN + touch for the Ed25519 signature, then again to open the PQ key)" || return 10
  local pq=()
  if pq_pinned; then pq=(--pq-key-file "$PQ_KEY_FILE"); fi
  with_maintainers XA "$WT" npx tsx tools/box-artifact/runtime-manifest.ts release --sign ${pq[@]+"${pq[@]}"}
  XA "$WT" npx tsx tools/box-artifact/runtime-manifest.ts verify --manifest "$out"
  local seq ver; seq=$(json_field manifest.sequence < "$out"); ver=$(json_field manifest.version < "$out")
  commit_paths "Runtime manifest: node $ver, sequence $seq" release/runtime-manifest.json
  st_w set runtimeManifestSequence "$seq"
  st_w set runtimeManifestValidUntil "$(json_field manifest.validUntil < "$out")"
  land_commits || return $?
}

shell_version_of() { sed -n 's/^const SHELL_VERSION = "\(v[0-9]*\)";.*/\1/p' "$1/apps/web/public/webapp/service-worker.js" | head -1; }
run_shellsig() {
  ensure_wt
  local v; v=$(shell_version_of "$WT")
  [ -n "$v" ] || fail "no SHELL_VERSION in apps/web/public/webapp/service-worker.js"
  if [ -f "$WT/release/webapp-shell/$v.json" ]; then ok "webapp shell $v is already signed (release/webapp-shell/$v.json)"; return 0; fi
  say "  Preview (no signature, no write):"
  XA "$WT" npx tsx scripts/webapp-shell.ts sign
  confirm "Sign webapp shell $v now? (YubiKey PIN + touch for the Ed25519 signature, then again to open the PQ key)" || return 10
  local pq=()
  if pq_pinned; then pq=(--key-file "$PQ_KEY_FILE"); else pq=(--no-pq); fi
  with_maintainers XA "$WT" npx tsx scripts/webapp-shell.ts sign --sign ${pq[@]+"${pq[@]}"}
  [ -f "$WT/release/webapp-shell/$v.json" ] || fail "release/webapp-shell/$v.json was not written"
  commit_paths "Sign webapp shell $v" "release/webapp-shell/$v.json"
  st_w set webappShellSigned "$v"
  land_commits || return $?
}

canary_percent() { # canary_percent <list file> <commit> -> the release's rollout percent, or nothing
  node -e 'const j=require(process.argv[1]);const r=j.releases.find(r=>r.commit===process.argv[2]);console.log(r?r.rolloutPercent:"")' "$1" "$2"
}
canary_verdict() { # stdin: npm run canary --json -> "<action> <next>" for the one release
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).rows[0];if(!r){console.log("wait");return}console.log(`${r.verdict.action} ${r.verdict.next??""}`.trim())})'
}
canary_publish() { # canary_publish <commit> <percent> <message>: sign the rollout change, upload it, commit the list
  local commit=$1 pct=$2 msg=$3 dir tmp n
  dir=$(st_get catalogKeyDir); [ -n "$dir" ] || dir=$(ask_word "Offline folder holding catalog-root-1.key.json and catalog-timestamp-1.key.json")
  [ -f "$dir/catalog-root-1.key.json" ] || fail "no root key in $dir"
  tmp=$(mktemp -d)
  curl -fsS -m 25 "$COM_URL/build/iso/catalog-targets.json" -o "$tmp/targets.json" || fail "cannot read the served catalog-targets.json"
  curl -fsS -m 25 "$COM_URL/build/iso/catalog-timestamp.json" -o "$tmp/timestamp.json" || fail "cannot read the served catalog-timestamp.json"
  WX npx tsx tools/release-catalog/catalog.ts rollout --root "$CATALOG_ROOT_FILE" --list release/catalog-releases.json --commit "$commit" --percent "$pct" \
    --key "$dir/catalog-root-1.key.json" --timestamp-key "$dir/catalog-timestamp-1.key.json" \
    --previous-targets "$tmp/targets.json" --previous-timestamp "$tmp/timestamp.json" --out-dir "$tmp/out"
  confirm "Upload the catalog with $(short "$commit") at $pct% to R2 flagship-iso?" || { rm -rf "$tmp"; return 10; }
  for n in targets snapshot timestamp; do WRX r2 object put "flagship-iso/catalog-$n.json" --file "$tmp/out/$n.json" --content-type application/json --remote; done
  rm -rf "$tmp"
  probe_code "catalog targets served" "$COM_URL/build/iso/catalog-targets.json" 200
  commit_paths "$msg" release/catalog-releases.json
  land_commits || return $?
}

run_canary() {
  ensure_wt
  [ -f "$WT/$CATALOG_ROOT_FILE" ] || { ok "no catalog root is pinned: every box takes the release, nothing to stage"; return 0; }
  local commit; commit=$(st_get artifactCommit); [ -n "$commit" ] || commit=$(json_field commit < "$WT/release/box-release.json")
  [ -f "$WT/release/catalog-releases.json" ] || fail "no release/catalog-releases.json: run the catalog step (3c) first"
  local pct; pct=$(canary_percent "$WT/release/catalog-releases.json" "$commit")
  [ -n "$pct" ] || fail "$(short "$commit") is not in release/catalog-releases.json: run the catalog step (3c) first"
  local opened; opened=$(st_get canaryOpenedAt)
  if [ -z "$opened" ]; then
    opened=$(date -u +%Y-%m-%dT%H:%M:%SZ); st_w set canaryOpenedAt "$opened"
    warn "no opening time was recorded for the ${pct}% stage: counting from now ($opened)"
  fi
  need_admin_secret || { warn "no admin secret: cannot read the receipts"; return 20; }
  say "  $(short "$commit") is at ${pct}%, this stage opened $opened"
  ( cd "$WT" && with_secret npx tsx scripts/canary.ts --release "$commit" --opened-at "$opened" ) || fail "npm run canary failed"
  local verdict action next
  verdict=$(cd "$WT" && with_secret npx tsx scripts/canary.ts --release "$commit" --opened-at "$opened" --json | canary_verdict)
  action=${verdict%% *}; next=${verdict#"$action"}; next=${next# }
  case "$action" in
    complete)
      ok "$(short "$commit") is at 100% and no receipt says it failed"; return 0 ;;
    wait)
      warn "not yet (see the verdict above): run this step again later with --only $CURRENT_STEP"; return 20 ;;
    stop)
      err "the canary says STOP for $(short "$commit") (docs/runbooks/canary.md, Stop)"
      if confirm "Sign and publish $(short "$commit") at 0% now (the stop rule)?"; then
        canary_publish "$commit" 0 "Canary stop: $(short "$commit") to 0%" || return $?
        st_w set canaryStoppedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      fi
      fail "the release is stopped: boxes that took it keep it; ship a fixed release with a higher security version" ;;
    hold)
      warn "the canary holds: one update rolled back. Find out why first (runbook: Reading a rollback)."
      local why; why=$(ask_word "Type the reason it is safe to widen anyway, or press Enter to wait")
      [ -n "$why" ] || return 20
      st_w set canaryHoldReason "$why"
      next=$(node -e 'const s=[1,5,20,50,100];console.log(s.find(x=>x>Number(process.argv[1]))??"")' "$pct") ;;
    widen) ;;
    *) fail "unexpected canary verdict: $verdict" ;;
  esac
  [ -n "$next" ] || fail "no next stage after ${pct}%"
  if [ "$(st_get canaryFirstGate)" != confirmed ]; then
    say "  Before the first widening: this release's gym run (step $(step_index gym)) must be green for the update and canary groups, and one deliberate rollback drill must have sent its receipt (runbook 9b)."
    [ "$(ask_word "Type  confirmed  when both are true")" = confirmed ] || return 20
    st_w set canaryFirstGate confirmed
  fi
  confirm "Widen $(short "$commit") from ${pct}% to ${next}%?" || return 20
  canary_publish "$commit" "$next" "Canary: $(short "$commit") to ${next}%" || return $?
  st_w set canaryOpenedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$next" = 100 ]; then ok "$(short "$commit") is at 100%"; return 0; fi
  ok "$(short "$commit") is at ${next}%: run this step again after the next observation window (--only $CURRENT_STEP)"
  return 20
}

# The broker URL .com is configured for (an uncommented DNS_BROKER_URL in its wrangler.toml), or nothing.
dns_broker_url() {
  sed -n 's/^[[:space:]]*DNS_BROKER_URL[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

run_dnsbroker() {
  ensure_wt
  local url names code n
  url=$(dns_broker_url "$WT/apps/com/wrangler.toml")
  if [ -z "$url" ]; then
    ok "apps/com/wrangler.toml sets no DNS_BROKER_URL: .com keeps its own DNS token; nothing to deploy"
    return 0
  fi
  names=$(cd "$WT/apps/dns-broker" && npx wrangler secret list 2>/dev/null | json_names || true)
  for n in CLOUDFLARE_DNS_API_TOKEN DNS_BROKER_SECRET; do
    printf '%s\n' "$names" | grep -qx "$n" || fail "the broker has no $n secret: (cd apps/dns-broker && npx wrangler secret put $n)"
  done
  XA "$WT/apps/dns-broker" npx wrangler deployments list
  confirm "Deploy the DNS broker (apps/dns-broker) from $(short "$PIN") now?" || return 10
  XA "$WT/apps/dns-broker" npm run deploy
  XA "$WT/apps/dns-broker" npx wrangler deployments list
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${url%/}/service" || true)
  [ "$code" = 401 ] || fail "$url/service answered $code without the secret (expected 401)"
  ok "the broker answers at $url"
}



run_kickoff() {
  [ -n "$(st_get endorsed)" ] || warn "no endorsement is recorded in this run: the appliances bake the newest endorsed release, so a build started before the endorsement is stale"
  XA "$REPO" gh run list --workflow vm-appliance.yml --limit 4
  confirm "Dispatch the amd64 and arm64 appliance builds on main now?" || return 10
  XA "$REPO" gh workflow run vm-appliance.yml --ref main -f arch=amd64 -f git_ref=main -f release=box-release
  XA "$REPO" gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=box-release
  st_w set applianceDispatchedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sleep 6
  XA "$REPO" gh run list --workflow vm-appliance.yml --limit 4
  say "  amd64 takes about an hour, arm64 (TCG) up to three. Step $(step_index publish) collects them."
}

KNOWN_SECRETS=(VOUCHER_SIGNING_KEYS OHTTP_GATEWAY_KEYS CLOUDFLARE_DIRECT_DNS_API_TOKEN CLOUDFLARE_DIRECT_ZONE_ID WEBPUSH_VAPID_PRIVATE_KEY_PEM WEBPUSH_VAPID_PUBLIC_KEY_B64URL WEBPUSH_CONTACT VOICI_CALL_POW_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET APPLE_IAP_ENVIRONMENTS GOOGLE_PLAY_SERVICE_ACCOUNT_JSON APNS_KEY_ID APNS_TEAM_ID APNS_PRIVATE_KEY_PEM SERVING_REVOCATION_SEED ISSUANCE_ACME_ACCOUNT_KEY RELAY_MESH_KEY_SEED ACCOUNT_READ_TOKEN_SECRET PB_TOKEN_RSA_JWK PB_FILLER_SECRET PB_TAG_SECRET FLAGSHIP_INFERENCE_TOKEN_SECRET FLAGSHIP_RECOVERY_PROOF_SECRET FLAGSHIP_TOTP_KEK ADAPTER_ATTESTATION_SIGNING_KEY ADAPTER_COMPLAINT_SALT VOICI_DEVICE_SECRET APPLE_TEAM_ID APPLE_DEVICECHECK_KEY_ID APPLE_DEVICECHECK_KEY PLAY_INTEGRITY_SA_JSON CLOUDFLARE_PURGE_TOKEN RESEND_API_KEY TURNSTILE_SECRET_KEY)
# Former secrets now set in wrangler.toml [vars] (owner, 2026-11-02: nothing confidential in them).
SECRETS_NOW_VARS=(FLAGSHIP_INFERENCE_ENDPOINT)
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
  # The DNS broker (step $(step_index dnsbroker)): .com needs the shared secret; the zone token comes off .com only after
  # the .com deploy that names the broker and a certificate order issued through it (0.4 deploy notes, F6).
  if [ -n "$(dns_broker_url "$WT/apps/com/wrangler.toml")" ]; then
    if echo "$prod" | grep -qx DNS_BROKER_SECRET; then ok "DNS_BROKER_SECRET is set on prod"; else warn "DNS_BROKER_SECRET is NOT on prod (the value the broker holds: cd apps/com && wrangler secret put DNS_BROKER_SECRET)"; missing=1; fi
    echo "$prod" | grep -qx CLOUDFLARE_DNS_API_TOKEN && say "  CLOUDFLARE_DNS_API_TOKEN is still on prod: delete it after the .com deploy, once an order issued through the broker"
  fi
  if [ "$missing" = 1 ]; then confirm "Some names are missing on prod. Continue anyway?" || return 10; fi
  # Settings that used to be secrets and are now plain [vars] in wrangler.toml: a deploy fails while a secret of the
  # same name exists, so the secret goes first (free AI reads as unavailable for the minutes until the deploy).
  for n in "${SECRETS_NOW_VARS[@]}"; do
    if echo "$prod" | grep -qx "$n"; then
      warn "$n is still a prod secret; it is now a plain setting in apps/com/wrangler.toml"
      confirm "Delete the prod secret $n now (the .com deploy then sets it from wrangler.toml)?" || return 10
      XA "$WT/apps/com" npx wrangler secret delete "$n"
    else
      ok "$n is not a secret on prod (it comes from wrangler.toml)"
    fi
  done
}

# "on" or "off": release/box-release.json `appBrowser` in the worktree (absent means off).
app_browser_state() {
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).appBrowser === true ? "on" : "off")' "$WT/release/box-release.json"
}

run_gym() {
  ensure_wt
  say "  The gym proves this commit live before prod, on both container stacks: arch-v2 (Podman + Rust,"
  say "  what new boxes are built on) runs every group, classic (Docker + TS, the boxes already out there)"
  say "  runs the groups covering them. arch-v2 not green: new boxes are built on classic. The policed"
  say "  app browser ships on only if its group (browser-grants) passes; if only it fails, it ships off."
  say "  Every group runs on real UpCloud boxes; the gym secrets come from $GYM_SECRETS_FILE."
  say "  It takes the gym lock, so no other live run may be in progress (the gym and prod share the"
  say "  Let's Encrypt budget of 50 a week). About 70 minutes."
  local base="${GYM_START_REF:-}"
  [ -n "$base" ] && say "  gym start ref: $base (GYM_START_REF)"
  if confirm "Run the release gym now (scripts/gym-release-run.sh on $(short "$PIN"))?"; then
    local rc=0
    if [ "$DRY" = 1 ]; then XA "$WT" bash scripts/gym-release-run.sh --dry-run; return 0; fi
    printf '%s+ (cd %s && bash scripts/gym-release-run.sh)%s\n' "$C_D" "$WT" "$C_0"
    ( cd "$WT" && GYM_SECRETS_FILE="$GYM_SECRETS_FILE" GYM_BASE_REF="${GYM_BASE_REF:-origin/main}" bash scripts/gym-release-run.sh ) || rc=$?
    case "$rc" in
      0) ok "every live group is green on both stacks on $(short "$PIN"): new boxes are built on $(json_field newBoxStack < "$WT/release/box-release.json"); the app browser ships $(app_browser_state)" ;;
      3) warn "nothing failed, but some groups were skipped (see the summary above)"
         [ "$(ask_word "Type  accept-skips  if every skip is an owner item you accept for this release")" = accept-skips ] || fail "gym inconclusive" ;;
      4) fail "the gym lock is held by another session: wait for it, then run this step again" ;;
      5) warn "classic is green, arch-v2 is not: new boxes must be built on classic for this release"
         confirm "Build new boxes on classic (Docker + the TS path) and push that to main?" || fail "the release needs a stack the gym proved"
         WX node scripts/set-new-box-stack.mjs classic
         local changed; changed=$(wt_git status --porcelain | awk '{print $2}')
         # shellcheck disable=SC2086
         commit_paths "Build new boxes on the classic stack (the release gym did not prove arch-v2)" $changed
         land_commits || return $?
         warn "the box artifacts and the gym ran on the previous pin: run this step again on the new one" ;;
      6) warn "every group is green except the policed app browser (browser-grants): it must ship OFF in this release"
         confirm "Ship the app browser off (release/box-release.json appBrowser false) and push that to main?" || fail "the app browser ships only if the gym proves it"
         WX node scripts/set-app-browser.mjs off
         local changed; changed=$(wt_git status --porcelain | awk '{print $2}')
         # shellcheck disable=SC2086
         commit_paths "Ship the app browser off (the release gym did not prove it)" $changed
         land_commits || return $?
         warn "the app browser ships OFF in this release; the box artifacts and the gym ran on the previous pin: run this step again on the new one" ;;
      *) fail "the gym run failed on the classic stack (exit $rc): fix on main, run this step again" ;;
    esac
  else
    say "  Run it yourself, in another terminal:  (cd $WT && GYM_SECRETS_FILE=$GYM_SECRETS_FILE bash scripts/gym-release-run.sh)"
    [ "$(ask_word "Type  verified  once that run exits 0 on $(short "$PIN")")" = verified ] || fail "gate not passed"
  fi
  cat <<'EOF'
  Also check, outside the runner:
    [ ] npx tsx tools/live-e2e/dns-ent-experiment.ts --canary exits 0 today (Cloudflare still
        keeps the root wildcard under a TXT)
    [ ] https://gym.flagshipserver.com/api/health and
        https://flagship-services-gym.fly.dev:8443/api/health answer 200
  NOT COVERED BY THE GYM: the static-only webapp Worker (flagship-webapp) that serves webapp. and
  remote.flagshipserver.com; the .com deploy's post-checks are its first real test.
EOF
  [ "$(ask_word "Type  verified  once both boxes are true")" = verified ] || fail "gate not passed"
  st_w set gymVerifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  st_w set gymVerifiedSha "$PIN"
}



run_migrations() {
  ensure_wt
  local json; json=$(WRQ d1 execute flagship-state --remote --json --command "SELECT version FROM schema_version ORDER BY version" 2>/dev/null || true)
  [ -n "$json" ] || fail "could not read the prod ledger (wrangler login?)"
  local pending
  pending=$(printf '%s' "$json" | pending_migrations "$WT/packages/storage/migrations")
  if [ -z "$pending" ]; then ok "nothing is pending: every migration file is in the prod ledger"; return 0; fi
  warn "pending migrations:"; echo "$pending" | sed 's/^/    /'
  say "  The setup check (step $(step_index setup)) proved the daily D1 backup is fresh: a migration cannot be undone."
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
  require_done setup migrations || return 10
  if [ "$(tr -d '[:space:]' < "$WT/release/runtime-manifest.json")" = null ]; then
    warn "release/runtime-manifest.json is still null (step $(step_index runtime)): /api/runtime/manifest will answer 204 and every Runtime card says 'not published'. Boxes keep updating on the artifact's signed lock."
    [ "$(ask_word "Type  no-runtime-manifest  to deploy anyway, or press Enter to stop and run step $(step_index runtime)")" = no-runtime-manifest ] || return 10
  fi
  if ! st_has done setup; then
    err "the setup check (step $(step_index setup)) is not recorded, so nothing proved the daily D1 backup works (the Worker keeps no backup of its own; Time Travel's 7 days is the only other net)."
    [ "$(ask_word "Type  no-backup-accepted  to deploy anyway, or press Enter to stop")" = no-backup-accepted ] || return 10
    st_w set noBackupAccepted "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  com_deploy || return $?
  com_checks zone
  if [ "$(tr -d '[:space:]' < "$WT/release/runtime-manifest.json")" != null ]; then
    probe_code "runtime manifest served" "$COM_URL/api/runtime/manifest" 200
  fi
  serving_relay_key
}

# The relay enforces the serving authority (docs/architecture-v2/serving-wiring.md) only once it holds the key
# .com signs revocations with. It must come AFTER .com's feed is live: a relay holding the key with no feed refuses
# new tunnels after a minute and closes them all after ten.
serving_relay_key() {
  hdr "Serving authority: the relay's revocation key"
  local key; key=$(curl -fsS -m 15 "$COM_URL/api/serving/revocation-key" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const k=JSON.parse(s).publicKey;if(/^[0-9a-f]{64}$/.test(k))process.stdout.write(k)}catch{}})' || true)
  if [ -z "$key" ]; then
    warn ".com serves no revocation key (SERVING_REVOCATION_SEED not set?): the relay stays without the serving authority. Create it: cd apps/com && openssl rand -hex 32 | wrangler secret put SERVING_REVOCATION_SEED, then run this step again."
    return 0
  fi
  say "  .com's revocation key: $key"
  if flyctl secrets list -a flagship-services 2>/dev/null | grep -qw FLAGSHIP_SERVING_REVOCATION_PUB; then
    ok "the relay already holds FLAGSHIP_SERVING_REVOCATION_PUB (set in 0.3; after a SERVING_REVOCATION_SEED change, set it again by hand: flyctl secrets set FLAGSHIP_SERVING_REVOCATION_PUB=<key above> -a flagship-services)"
    return 0
  else
    confirm "Give the relay this key now (turns on the serving authority; a rolling restart)?" || { warn "the relay runs without the serving authority until this is set"; return 0; }
  fi
  XA "$WT" flyctl secrets set "FLAGSHIP_SERVING_REVOCATION_PUB=$key" -a flagship-services
  PROBE_FAILS=0
  probe_code ".services health" "$SERVICES_URL/api/health" 200 8
  probe_end
  say "  check by hand that the feed is up: curl -H 'x-usage-secret: <secret>' $SERVICES_URL/api/stats  (serving.contact true, feed.lag 0)"
}
require_gym_gate() {
  st_has done gym || fail "the gym gate (step $(step_index gym)) is not recorded: nothing deploys to prod until it passes"
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


relay_ips() { # prints "<v4> <v6>" from apps/com/wrangler.toml
  local v4 v6
  v4=$(sed -n 's/^SERVICES_PASSTHROUGH_IPV4 *= *"\(.*\)"/\1/p' "$WT/apps/com/wrangler.toml" | head -1)
  v6=$(sed -n 's/^SERVICES_PASSTHROUGH_IPV6 *= *"\(.*\)"/\1/p' "$WT/apps/com/wrangler.toml" | head -1)
  echo "$v4 $v6"
}

# ---------------------------------------------------------------- the relay mesh (docs/runbooks/final-deploy.md 1c-1e, 8a-8f)

r2_buckets_ok() { # every bucket the pinned wrangler.toml binds exists (a missing one is offered for creation)
  local want have missing b
  want=$(wrangler_buckets < "$WT/apps/com/wrangler.toml")
  [ -n "$want" ] || { err "no bucket_name found in apps/com/wrangler.toml"; return 11; }
  have=$(WRQ r2 bucket list 2>/dev/null | r2_bucket_names || true)
  [ -n "$have" ] || { err "could not list the R2 buckets (wrangler login?)"; return 11; }
  missing=$(printf '%s\n' "$want" | names_missing "$have")
  [ -z "$missing" ] && { ok "every R2 bucket apps/com/wrangler.toml binds exists"; return 0; }
  for b in $missing; do
    warn "R2 bucket $b is bound in apps/com/wrangler.toml but does not exist: the .com deploy fails without it (runbook 1c)"
    confirm "Create R2 bucket $b now (private, no public access)?" || return 10
    WRX r2 bucket create "$b"
  done
  have=$(WRQ r2 bucket list 2>/dev/null | r2_bucket_names || true)
  missing=$(printf '%s\n' "$want" | names_missing "$have")
  [ -z "$missing" ] || { err "still missing after the create: $missing"; return 11; }
  ok "every bound bucket exists"
}

SETUP_BAD=0
setup_ok()   { ok "$1"; }
setup_fail() { err "$1 (set it up again: runbook $2)"; SETUP_BAD=1; }

# One-time setup that happened in earlier releases (runbook 1f): read-only, one ok line each, no prompt while it holds.
run_setup() {
  ensure_wt
  SETUP_BAD=0
  local names s n rules tmp code v4 v6 got4 got6 caa
  if [ -f "$WT/$CATALOG_ROOT_FILE" ]; then setup_ok "release catalog root pinned ($CATALOG_ROOT_FILE)"; else setup_fail "no release catalog root is pinned" 2b; fi
  if pq_pinned; then setup_ok "PQ release key pinned (release/box-artifact-trust.json)"; else setup_fail "the PQ release key is not pinned" 2c; fi
  names=$( (cd "$WT" && gh secret list 2>/dev/null) | gh_secret_names || true)
  for s in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    if echo "$names" | grep -qx "$s"; then setup_ok "repo secret $s"; else setup_fail "repo secret $s is missing (the D1 backup workflow needs it)" 1b; fi
  done
  if age_recipient_ok < "$WT/.maintainers/backup-recipient.pub"; then setup_ok "the D1 backup is encrypted to a real age key"; else setup_fail ".maintainers/backup-recipient.pub is the placeholder" 1b; fi
  rules=$(WRQ r2 bucket lifecycle list flagship-d1-backups 2>&1 || true)
  if echo "$rules" | grep -q 'd1/daily/'; then setup_ok "flagship-d1-backups expires d1/daily/ after 30 days"; else setup_fail "no d1/daily/ lifecycle rule on flagship-d1-backups (or no bucket)" 1b; fi
  tmp=$(mktemp "$RELEASE_HOME/latest.XXXXXX")
  if ( cd "$WT/apps/com" && WR r2 object get flagship-d1-backups/latest.json --file "$tmp" --remote >/dev/null 2>&1 ) && latest_json_ok 2160 < "$tmp" >/dev/null; then
    setup_ok "daily D1 backup: $(latest_json_ok 2160 < "$tmp")"
  else setup_fail "the daily D1 backup is missing or over 36 hours old (gh run list --workflow d1-backup.yml)" 1b; fi
  rm -f "$tmp"
  local rc=0; r2_buckets_ok || rc=$?
  [ "$rc" = 10 ] && return 10
  [ "$rc" = 0 ] || SETUP_BAD=1
  code=$(http_code "$FEED_URL/head.json")
  case "$code" in 200|404) setup_ok "feed.flagshipserver.com answers over valid TLS ($code)" ;; *) setup_fail "feed.flagshipserver.com answered $code (000 = no TLS or no answer)" 1d ;; esac
  names=$(WRQ secret list 2>/dev/null | json_names || true)
  for n in RELAY_MESH_KEY_SEED SERVING_REVOCATION_SEED; do
    if echo "$names" | grep -qx "$n"; then setup_ok ".com holds $n"; else setup_fail ".com has no $n secret" 1e; fi
  done
  read -r v4 v6 < <(relay_ips)
  got4=$(dig +short A anything-at-all.flagship.services @1.1.1.1 2>/dev/null | head -1 || true)
  if [ -n "$v4" ] && [ "$got4" = "$v4" ]; then setup_ok "the root wildcard A answers the relay ($v4)"; else setup_fail "the root wildcard A answered '$got4', want '$v4'" 6a; fi
  if [ -n "$v6" ]; then
    got6=$(dig +short AAAA anything-at-all.flagship.services @1.1.1.1 2>/dev/null | head -1 || true)
    if [ "$got6" = "$v6" ]; then setup_ok "the root wildcard AAAA answers the relay ($v6)"; else setup_fail "the root wildcard AAAA answered '$got6', want '$v6'" 6a; fi
  fi
  caa=$(dig +short CAA flagship.services @1.1.1.1 2>/dev/null || true)
  if echo "$caa" | grep -q issuewild && echo "$caa" | grep -q 'letsencrypt.org'; then setup_ok "the apex CAA names Let's Encrypt"; else setup_fail "the apex CAA is not visible: '$caa'" 6a; fi
  [ "$SETUP_BAD" = 0 ] || return 11
}



# --json: the table marks a staged secret "* NAME", which a first-word parse read as "*".
fly_secret_names() { flyctl secrets list -a "$RELAY_APP" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const x of JSON.parse(s))console.log(x.name??x.Name)}catch{}})' | sort -u; }





toml_var() { sed -n "s/^$2 = \"\(.*\)\".*/\1/p" "$1" | head -1; }


relay_echo_check() { # the relay echo (docs/relay-addresses.md): the phones drop any address whose echo is not itself
  local v4 v6; read -r v4 v6 < <(relay_ips)
  hdr "Relay echo (:8444) on the dedicated address"
  if command -v openssl >/dev/null 2>&1 && [ -n "$v4" ]; then
    local e; e=$(printf 'GET /echo HTTP/1.1\r\nHost: flagship-services.fly.dev\r\nConnection: close\r\n\r\n' | openssl s_client -quiet -connect "$v4:8444" -servername flagship-services.fly.dev 2>/dev/null | tr -d '\r' | tail -3)
    say "  echo answered: ${e:-nothing}"
    if echo "$e" | grep -q "$v4"; then ok "the echo names the dedicated address $v4"
    else warn "the echo did not name $v4. If it names something else (or an IPv4-mapped IPv6 form), .com's addresses will fail the phones' echo check and they fall back to the built-in pair (safe); fix before relying on .com's list. Record the result: npm run release-manifest -- receipt relay-echo-live <note>"; fi
  else warn "openssl or the relay address is missing; run the echo check by hand (docs/relay-addresses.md)"; fi
}

mesh_rollback_text() {
  cat <<EOF

  Rollback (docs/runbooks/final-deploy.md 8f; boxes need nothing, they redial the same addresses):
    1. Rust -> TS hub, mesh kept (same relay id, key, secrets):
         flyctl deploy -c fly.mesh.toml -a $RELAY_APP --remote-only --strategy=rolling --yes
         npx tsx tools/relay-conformance/live-check.ts --relay $MESH_RELAY_HOST --expect ts
    2. TS mesh -> mesh off (today's relay: .com's internal routes and feed WebSocket still exist this release):
         flyctl deploy -a $RELAY_APP --remote-only --strategy=rolling --yes            (fly.toml)
         flyctl scale count 2 -a $RELAY_APP --yes
       TUNNEL_HUB_URL can stay at tunnel.flagship.services (same app); RELAY_MESH may stay on (the log keeps publishing).
    Back again: flyctl scale count 1 -a $RELAY_APP --yes, then fly.relay.mesh.toml as in step $(step_index meshrelay).
EOF
}

health_of() { curl -s -m 20 "https://$1:8443/api/health" 2>/dev/null || true; }
health_code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "https://$1:8443/api/health" 2>/dev/null || echo 000; }

run_meshcheck() {
  ensure_wt
  local bad=0 names n h toml="$WT/apps/com/wrangler.toml"
  if curl -fsS -m 20 "$FEED_URL/directory.json?release=$(date +%s)" 2>/dev/null | directory_lists "$MESH_RELAY_ID"; then ok "the feed directory lists $MESH_RELAY_ID"
  else err "the feed directory does not list $MESH_RELAY_ID (runbook 8b admits it, 8d mints the directory)"; bad=1; fi
  names=$(fly_secret_names)
  for n in FLAGSHIP_RELAY_KEY_SEED SERVICES_CONTROL_SECRET; do
    if echo "$names" | grep -qx "$n"; then ok "$n is on $RELAY_APP"; else err "$n is not on $RELAY_APP (runbook 8a)"; bad=1; fi
  done
  if echo "$names" | grep -qxE 'FLAGSHIP_RELAY_LOG_PUB|FLAGSHIP_SERVING_REVOCATION_PUB'; then ok "$RELAY_APP holds .com's relay-log key"
  else err "neither FLAGSHIP_RELAY_LOG_PUB nor FLAGSHIP_SERVING_REVOCATION_PUB is on $RELAY_APP (runbook 8a)"; bad=1; fi
  for h in "$MESH_RELAY_HOST" "$MESH_TUNNEL_HOST"; do
    if [ "$(health_code "$h")" = 200 ]; then ok "$h :8443 answers over valid TLS"; else err "$h :8443 does not answer over valid TLS (runbook 8c)"; bad=1; fi
  done
  if [ "$(toml_var "$toml" RELAY_MESH)" = on ] && [ "$(toml_var "$toml" TUNNEL_HUB_URL)" = "$MESH_HUB_URL" ]; then ok "apps/com/wrangler.toml: RELAY_MESH on, TUNNEL_HUB_URL $MESH_HUB_URL"
  else err "apps/com/wrangler.toml does not keep RELAY_MESH on and TUNNEL_HUB_URL $MESH_HUB_URL (runbook 8d)"; bad=1; fi
  [ "$bad" = 0 ] || return 11
}

run_meshrelay() {
  require_done meshcheck || return 10
  ensure_wt
  [ -f "$WT/fly.relay.mesh.toml" ] || fail "fly.relay.mesh.toml is not on the pinned commit"
  local h
  if [ -n "${USAGE_REPORT_SECRET:-}" ]; then ( cd "$WT" && npm run -s ops -- services ) 2>&1 | head -12 | sed 's/^/    /' || true
  else say "  (USAGE_REPORT_SECRET is not in this shell: run 'npm run ops -- services' in another terminal for the box tunnel count.)"; fi
  local base; base=$(ask_word "Box tunnels online right now (a number, or Enter for none)")
  [[ "$base" =~ ^[0-9]+$ ]] && st_w set meshBaseline "$base" || st_w set meshBaseline ""
  local count; count=$(flyctl machines list -a "$RELAY_APP" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch{console.log("?")}})')
  say "  machines now: $count"
  if [ "$count" != 1 ]; then
    say "  One relay id runs on exactly one machine. Scaling down destroys the extra machine; its boxes get DrainNotice and redial the one left."
    confirm "Scale $RELAY_APP to ONE machine now (flyctl scale count 1)?" || return 10
    WX flyctl scale count 1 -a "$RELAY_APP" --yes
  fi
  cat <<'EOF'

  The deploy stops the ONLY machine and starts the Rust relay: every box tunnel drops for about 20-60 s and
  redials (DrainNotice first, then 1012). Quiet hours. Never --strategy=immediate, never bluegreen here.
EOF
  confirm "Deploy the Rust relay as $MESH_RELAY_ID now (fly.relay.mesh.toml, rolling)?" || return 10
  WX flyctl deploy -c fly.relay.mesh.toml -a "$RELAY_APP" --remote-only --strategy=rolling --yes
  st_w set meshRelayDeployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  st_w set meshRelayImpl rust
  PROBE_FAILS=0
  local i line
  for i in $(seq 1 18); do
    line=$(health_of "$MESH_RELAY_HOST" | health_line)
    [ "$(health_code "$MESH_RELAY_HOST")" = 200 ] && case "$line" in "rust ready"*) break ;; esac
    sleep 10
  done
  say "  $MESH_RELAY_HOST: $line"
  case "$line" in "rust ready"*) ok "iad1 is the Rust relay and mesh-ready" ;; *) err "iad1 is not a mesh-ready Rust relay after 3 minutes: $line"; PROBE_FAILS=$((PROBE_FAILS + 1)) ;; esac
  for h in "$MESH_RELAY_HOST" flagship-services.fly.dev; do
    printf '%s+ npx tsx tools/relay-conformance/live-check.ts --relay %s --expect rust%s\n' "$C_D" "$h" "$C_0"
    ( cd "$WT" && npx tsx tools/relay-conformance/live-check.ts --relay "$h" --expect rust ) || { err "live-check on $h failed"; PROBE_FAILS=$((PROBE_FAILS + 1)); }
  done
  printf '%s+ npm run ops -- mesh%s\n' "$C_D" "$C_0"
  ( cd "$WT" && npm run -s ops -- mesh ) || { err "ops -- mesh reported a problem"; PROBE_FAILS=$((PROBE_FAILS + 1)); }
  relay_echo_check
  count=$(flyctl machines list -a "$RELAY_APP" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch{console.log("?")}})')
  if [ "$count" = 1 ]; then ok "one machine"; else err "$count machines (want 1): flyctl scale count 1 -a $RELAY_APP --yes"; PROBE_FAILS=$((PROBE_FAILS + 1)); fi
  mesh_rollback_text
  probe_end || return $?
  if confirm "Watch the relay for 30 minutes now? (no: check it later by hand, $MESH_RELAY_HOST:8443/api/health and npm run ops -- mesh)"; then
    mesh_watch || return $?
  else
    warn "no watch now: check $MESH_RELAY_HOST:8443/api/health and npm run ops -- mesh within the hour"
  fi
}

mesh_watch() {
  local base; base=$(st_get meshBaseline)
  local mins=${MESH_WATCH_MINUTES:-30} i code line n peak=0 fails=0 low=0 bad=0
  say "  watching $MESH_RELAY_HOST for $mins minutes (baseline: ${base:-none}); Ctrl-C stops, resume with --only $CURRENT_STEP"
  for ((i = 1; i <= mins; i++)); do
    code=$(health_code "$MESH_RELAY_HOST")
    line=$(health_of "$MESH_RELAY_HOST" | health_line)
    n=$(echo "$line" | awk '{print $3}')
    printf '  %s  min %2d  http %s  %s\n' "$(date -u +%H:%M:%S)" "$i" "$code" "$line"
    if [ "$code" = 200 ]; then fails=0; else fails=$((fails + 1)); fi
    [ "$fails" -ge 3 ] && { err "three non-200 answers in a row"; bad=1; break; }
    if [ "$code" = 200 ]; then case "$line" in rust*) ;; *) err "the relay answering is not the Rust relay: $line"; bad=1; break ;; esac; fi
    if [[ "$n" =~ ^[0-9]+$ ]]; then
      [ "$n" -gt "$peak" ] && peak=$n
      if [ "$i" -ge 10 ] && ! tunnels_ok "$n" "$base" "$peak"; then low=$((low + 1)); else low=0; fi
      [ "$low" -ge 5 ] && { err "tunnels online ($n) below 80% of max(baseline ${base:-0}, peak $peak) for 5 minutes"; bad=1; break; }
    fi
    [ "$i" -lt "$mins" ] && sleep 60
  done
  printf '%s+ npm run ops -- mesh%s\n' "$C_D" "$C_0"
  ( cd "$REPO" && npm run -s ops -- mesh ) || warn "ops -- mesh reported a problem"
  if [ "$bad" = 1 ]; then mesh_rollback_text; return 11; fi
  case "$line" in "rust ready"*) ok "30 minutes clean: iad1 is the Rust relay, mesh-ready, $n tunnels (peak $peak)" ;; *) warn "the watch ended with: $line"; mesh_rollback_text; confirm "Treat the watch as passed anyway?" || return 11 ;; esac
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
    if [ -z "$id" ]; then st_w add deferred "$arch"; warn "$arch deferred: the phase B redeploy publishes it"; return 20; fi
  fi
  smoke_ok "$id" || { err "run $id: the boot smoke step is not green"; st_w add deferred "$arch"; return 20; }
  ok "$arch: run $id is green with the boot smoke passing"
  confirm "Publish the $arch appliance from run $id to R2 (uploads about 2.5 GB)?" || { st_w add deferred "$arch"; return 20; }
  [ "$(free_gb "$HOME")" -ge 5 ] || fail "need more than 5 GB free to download the appliance"
  XA "$WT" env "PATH=$PATH" bash scripts/publish-vm-appliance.sh "$id"
  local mf="$WT/apps/web/public/downloads/FlagshipVMAppliance-$arch.json" commit sha
  commit=$(json_field commit < "$mf"); sha=$(json_field sha256 < "$mf")
  # Studios use an appliance only when its commit equals the recipe's, i.e. box-release.json's commit.
  local want; want=$(st_get artifactCommit); [ -n "$want" ] || want=$(json_field commit < "$WT/release/box-release.json")
  if [ -n "$want" ] && [ "$commit" != "$want" ]; then warn "the $arch image bakes $(short "$commit"), not the box release $(short "$want") that recipes name"; confirm "Publish it anyway?" || return 11; fi
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
  [ "$rc" = 20 ] && say "  arm64 is left for the phase B redeploy (step $(step_index redeployB)), which publishes it first."
  land_commits || return $?
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
  local planned; planned=$(ask_word "Is a device test (the Windows agent, hardware) planned against this deploy? [y/N]")
  case "$planned" in y|Y|yes) ;; *) ok "no device test planned: no status file"; return 0 ;; esac
  local machine; machine=$(ask_word "Which machine (a short name, default windows)"); machine=${machine:-windows}
  [[ "$machine" =~ ^[a-z0-9-]+$ ]] || fail "use lowercase letters, digits and dashes"
  ensure_wt
  local date out; date=$(date -u +%Y-%m-%d); out="$RELEASE_HOME/DEPLOYED-FINAL-$date.md"
  local results="device-results/$machine-$date"
  local endorsed shell arch row=""
  endorsed=$(st_get endorsed); [ -n "$endorsed" ] || endorsed=$(latest_endorsed)
  shell=$(live_shell_version)
  for arch in amd64 arm64; do
    if [ -f "$WT/apps/web/public/downloads/FlagshipVMAppliance-$arch.json" ] && [ -n "$(st_get "appliance_$arch")" ]; then
      row="$row- $arch: sha256 \`$(st_get "appliance_$arch")\` (run $(st_get "applianceRun_$arch"), bakes \`$(json_field commit < "$WT/apps/web/public/downloads/FlagshipVMAppliance-$arch.json")\`)
"
    else row="$row- $arch: NOT published yet (the older image is still what Studio downloads for $arch)
"; fi
  done
  {
    echo "# DEPLOYED-FINAL $date"
    echo
    echo "This is the real deployed state the device test should run against. Nothing below is a caveat: if a line is not true when you test, stop and report it."
    echo
    echo "- main (release pin): \`$PIN\`"
    echo "- endorsed release commit (what new boxes install): \`$endorsed\`"
    echo "- .com deployed from: \`$(st_get comDeployedSha)\`, webapp shell version live: \`${shell:-unknown}\`"
    echo "- .services: the Rust mesh relay iad1 (one machine), deployed from this release"
    echo "- DNS design: the flagship.services zone holds a root wildcard (\`*\` A and AAAA, DNS only, grey cloud, pointing at the relay) and an apex CAA pair (issue and issuewild: letsencrypt.org). Accounts and boxes hold no address or CAA records; only short-lived \`_acme-challenge\` TXT records exist during issuance."
    echo "- Workers plan: $(st_get workersPlan)"
    echo "- Published VM appliances (Studio \"Host on this PC\" downloads these):"
    printf '%s' "$row"
    echo "- Not live yet (phase B): the public Windows and Linux Studio release, the reap, the store builds."
    echo "- The Studio under test is still the previous build; the download links on the site are unchanged."
  } > "$out"
  hdr "Status file ($out)"
  cat "$out"
  echo
  confirm "Commit this to branch $results as device-results/DEPLOYED-FINAL-$date.md (plain push, no force)?" || { say "  left at $out"; return 0; }
  local tw="$RELEASE_HOME/wt-results" base="origin/main"
  if git -C "$REPO" fetch -q origin "+refs/heads/$results:refs/remotes/origin/$results" 2>/dev/null; then base="origin/$results"; else say "  $results is new: it starts from main"; fi
  case "$tw" in "$RELEASE_HOME"/*) rm -rf "$tw" ;; esac
  git -C "$REPO" worktree prune
  X git -C "$REPO" worktree add --detach "$tw" "$base"
  mkdir -p "$tw/device-results"
  cp "$out" "$tw/device-results/DEPLOYED-FINAL-$date.md"
  X git -C "$tw" add -- "device-results/DEPLOYED-FINAL-$date.md"
  X git -C "$tw" commit -q -m "Record the deployed final state for the $machine test ($date)" -- "device-results/DEPLOYED-FINAL-$date.md"
  local rc=0
  git -C "$tw" push origin "HEAD:refs/heads/$results" || rc=$?
  git -C "$REPO" worktree remove --force "$tw" >/dev/null 2>&1 || true
  [ "$rc" = 0 ] || fail "the push to $results was not a fast-forward (someone pushed to it): fetch it and run this step again"
  ok "pushed to $results"
}

run_notice() {
  ensure_wt
  local msg event
  msg="We will update Flagship on {date}. Your servers keep running, but flagshipserver.com may be briefly unavailable."
  event=$(ask_word "When is the maintenance? ISO time, e.g. 2026-12-02T09:00:00Z (Enter = no notice)")
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

# Older apps learn they must update only from a signed notice (journal F9): their release builds show an
# update-required notice as a banner with an Update button (never a lock); an older webapp shell locks until it reloads.
run_upgradenotice() {
  ensure_wt
  local ib av iv pv sv msg reason event lock advisory
  ib=$(node -p "require('$WT/release/version.json').iosBuild"); av=$(node -p "require('$WT/release/version.json').androidVersionCode")
  iv=$(node -p "require('$WT/release/version.json').iosVersion"); pv=$(node -p "require('$WT/release/version.json').product")
  sv=$(shell_version "$WT"); sv=${sv#v}
  say "  The notice names this release's builds as the minimum: iOS $iv ($ib), Android versionCode $av, webapp shell v$sv."
  [ "$(ask_word "Does this release leave older apps unable to work, so they must update? [y/N]")" = y ] || { ok "no update notice for $pv"; return 0; }
  say "  Only once BOTH stores carry these builds: the banner's Update button opens the store, so before approval it"
  say "  would send people to the version they already have."
  [ "$(ask_word "Type  approved  when App Store and Google Play both show iOS $iv ($ib) and Android $av (Enter = later)")" = approved ] || return 20
  msg="Flagship $pv is here. Update the app to keep using your account and servers: this version no longer works with them."
  reason=$(ask_word "The security reason in one sentence (it is shown and signed)")
  [ -n "$reason" ] || return 10
  event=$(ask_word "When were the store builds approved? ISO time, e.g. 2026-11-20T00:00:00Z")
  [ -n "$event" ] || return 10
  lock=$(ask_word "When should an older webapp shell lock? ISO time or now (Enter = now)"); lock=${lock:-now}
  advisory=$(ask_word "Advisory id for the security fixes (e.g. FSA-2026-004)")
  [ -n "$advisory" ] || return 10
  local args=(required --message "$msg" --event "$event" --lock-at "$lock" --platform "ios:$ib" --platform "android:$av" --platform "web:$sv" --advisory "$advisory" --security-reason "$reason")
  say "  Preview (writes nothing):"
  with_maintainers XA "$WT" node scripts/security-notice.mjs "${args[@]}"
  say ""
  say "  To publish it, sign in ANOTHER terminal (the YubiKey PIN prompt reads /dev/tty):"
  say ""
  say "      cd $WT"
  say "      ln -s $MAIN_CHECKOUT/maintainers maintainers"
  say "      node scripts/security-notice.mjs required --message \"$msg\" --event $event --lock-at $lock --platform ios:$ib --platform android:$av --platform web:$sv --advisory $advisory --security-reason \"$reason\" --sign"
  say "      rm maintainers"
  say ""
  say "  Then come back here. This step commits .maintainers/notices, pushes it and redeploys .com."
  [ "$(ask_word "Type  signed  when done, or press Enter to leave it for later")" = signed ] || return 20
  [ -n "$(wt_git status --porcelain -- .maintainers/notices)" ] || fail "nothing new under .maintainers/notices in the worktree"
  commit_paths "Notice: apps before $pv must update" .maintainers/notices
  land_commits || return $?
  com_deploy || return $?
  say "  $(curl -s -m 25 "$COM_URL/api/notices" | head -c 400)"
  com_checks
}


GYM_LOCK="${FLAGSHIP_GYM_LOCK:-/private/tmp/claude-501/flagship-locks/gym.lock}"
gym_lock_held() { [ -e "$GYM_LOCK" ]; }

# The gym sweep authenticates to the GYM Worker with the gym's own admin secret, never prod's
# (0.3's step 36 ran with neither and got 401). Taken from the environment, else the main
# checkout's .gym-secrets.env, else typed silently; never put in argv or the log.
GYM_SECRETS_FILE="${FLAGSHIP_GYM_SECRETS_FILE:-$MAIN_CHECKOUT/.gym-secrets.env}"
GYM_SECRET="${GYM_ADMIN_SECRET:-}"
env_file_value() { # env_file_value file NAME: the value of NAME=..., `export NAME=...` too, without surrounding quotes
  node -e '
const [f,k]=process.argv.slice(1);let t="";try{t=require("fs").readFileSync(f,"utf8")}catch{process.exit(0)}
for(const line of t.split(/\r?\n/)){const m=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(!m||m[1]!==k)continue;
let v=m[2];const q=v[0];if((q===`"`||q==="\x27")&&v.endsWith(q)&&v.length>=2)v=v.slice(1,-1);else v=v.replace(/\s+#.*$/,"");process.stdout.write(v);break}' "$1" "$2"
}
need_gym_secret() {
  [ -n "$GYM_SECRET" ] && return 0
  if [ -f "$GYM_SECRETS_FILE" ]; then
    GYM_SECRET=$(env_file_value "$GYM_SECRETS_FILE" GYM_ADMIN_SECRET)
    [ -n "$GYM_SECRET" ] && return 0
  fi
  printf '%sGYM_ADMIN_SECRET%s (not in %s; typed silently, kept in memory; empty = stop): ' "$C_Y" "$C_0" "$GYM_SECRETS_FILE" >&2
  read -rs GYM_SECRET || GYM_SECRET=""
  echo >&2
  [ -n "$GYM_SECRET" ]
}
with_gym_secret() { ( unset FLAGSHIP_ADMIN_SECRET; GYM_ADMIN_SECRET="$GYM_SECRET"; export GYM_ADMIN_SECRET; "$@" ); }

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
      need_gym_secret || fail "the gym sweep needs GYM_ADMIN_SECRET: put it in $GYM_SECRETS_FILE (or type skip-gym), then rerun this step"
      # A refused dry run fails here (sweep-cli exits 1), so the destroy prompt never offers an unseen list.
      with_gym_secret XA "$WT" npx tsx tools/live-e2e/sweep-cli.ts
      confirm "Destroy those gym leftovers (sweep-cli --destroy)? If it reports dnsFailed, wait 30 s and run it again." || return 10
      with_gym_secret XA "$WT" npx tsx tools/live-e2e/sweep-cli.ts --destroy
      st_w set reapGymSweep swept ;;
    skip-gym) warn "gym sweep skipped by you: shared-zone gym records and gym servers may remain"; st_w set reapGymSweep skipped ;;
    *) fail "answer sweep or skip-gym (got '$g'); rerun the step" ;;
  esac
  local plan="$HOME/pre-ga-reap-plan.json" after="$HOME/pre-ga-reap-plan-after.json"
  hdr "Reap dry run (writes nothing in Cloudflare, UpCloud or D1)"
  printf '%s+ node scripts/reap-orphans.mjs --show --out %s%s\n' "$C_D" "$plan" "$C_0"
  with_secret bash -c "cd '$WT' && node scripts/reap-orphans.mjs --show --out '$plan'" || fail "the reap dry run failed"
  say "  Read it: orphans are records and demo servers of accounts that no longer exist; the review account playstore-test-0725 is kept; the zone after the reap is well under 200."
  confirm "Apply this plan? (the tool prints it again and asks you to type 'delete N records and M servers')" || return 10
  printf '%s+ node scripts/reap-orphans.mjs --apply --plan %s%s\n' "$C_D" "$plan" "$C_0"
  with_secret bash -c "cd '$WT' && node scripts/reap-orphans.mjs --apply --plan '$plan'" || fail "the reap apply reported failures (see $plan.log.jsonl); rerun the step"
  hdr "Verify"
  with_secret bash -c "cd '$WT' && node scripts/reap-orphans.mjs --show --out '$after'" || fail "the second dry run failed: the left-on-purpose review needs it; rerun the step"
  with_secret bash -c "cd '$WT' && npm run -s zone-health" || { PROBE_FAILS=$((PROBE_FAILS + 1)); err "zone-health is not OK"; }
  mirror_dns_check || { PROBE_FAILS=$((PROBE_FAILS + 1)); err "mirror-dns: a proxied fshp.tech / fshp.app record is missing: put it back"; }
  hdr "Left on purpose (from the second dry run)"
  printf '%s+ node scripts/reap-orphans.mjs --review --plan %s%s\n' "$C_D" "$after" "$C_0"
  ( cd "$WT" && node scripts/reap-orphans.mjs --review --plan "$after" ) || { PROBE_FAILS=$((PROBE_FAILS + 1)); err "the second dry run still lists records or servers to delete"; }
  say "  The protected review account keeps its own records (a warning) until its store review ends."
  probe_end || return $?
  reap_review_ack
  run_owner_checklist
}


studio_version() { node -p "require('$WT/release/version.json').studio"; }


run_studiowl() {
  ensure_wt
  local v tag; v=$(studio_version); tag="studio-v$v"
  say "  Studio version from release/version.json: $v (tag $tag)"
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


# 0.2 Studios can't tell they're out of date; the pairing relay tells them once newer Studios are downloadable
# (STUDIO_PIPE_MIN, builderRelay.ts; journal F9). Never before: a refused 0.2 Studio would have nothing to update to.
studio_pipe_switch() {
  local toml="$WT/apps/com/wrangler.toml"
  if grep -q '^STUDIO_PIPE_MIN *= *"2"' "$toml"; then ok "STUDIO_PIPE_MIN is on: 0.2 Studios are told to download the new one"; return 0; fi
  if ! st_has done studiowl || ! st_has done studiomac; then
    warn "the new Studios are not all published (steps studiowl, studiomac): 0.2 Studios keep pairing for now"; return 0
  fi
  confirm "All three new Studios are downloadable. Turn on STUDIO_PIPE_MIN=2, so a 0.2 Studio is told to download the new one when it pairs?" || return 0
  sed -i.bak 's/^# STUDIO_PIPE_MIN = "2"$/STUDIO_PIPE_MIN = "2"/' "$toml" && rm -f "$toml.bak"
  grep -q '^STUDIO_PIPE_MIN = "2"' "$toml" || fail "could not turn on STUDIO_PIPE_MIN in apps/com/wrangler.toml"
  commit_paths "Tell 0.2 Studios to download the new one" apps/com/wrangler.toml
  land_commits || return $?
}

run_redeployB() {
  ensure_wt   # the pipe switch below edits the worktree's wrangler.toml; a --from run has none yet
  if [ -z "$(st_get appliance_arm64)" ]; then
    say "  the arm64 VM appliance is still pending: publishing it first"
    local rc=0; publish_arch arm64 || rc=$?
    case "$rc" in 0) land_commits || return $? ;; 20) warn "arm64 is still not ready: Studio keeps the older arm64 image (run this step again later)" ;; *) return "$rc" ;; esac
  fi
  studio_pipe_switch || return $?
  # Phase B may land migrations after the migrations step ran (0131 did): apply them before the Worker that reads them.
  run_migrations || return $?
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

run_storeart() {
  ensure_wt
  local n; n=$(grep -c '^- \[ \]' "$WT/i18n/REVIEW.md" 2>/dev/null || true)
  say "  native review: ${n:-0} line(s) of i18n/REVIEW.md still wait for a native reader (status only; npm run i18n gates the translations)"
  # The native captures (and the rendered store/out) are git-ignored: they live in the checkout that made them, so
  # bring that checkout's copies into the release worktree before checking them against the pinned code.
  local sd
  for sd in captures out; do
    if [ -d "$REPO/store/$sd" ]; then rm -rf "$WT/store/$sd"; mkdir -p "$WT/store"; cp -R "$REPO/store/$sd" "$WT/store/$sd"; fi
  done
  local rc=0
  [ -f "$WT/store/out/manifest.json" ] || ( cd "$WT" && npm run -s store-assets:render ) || rc=$?
  [ "$rc" = 0 ] && { ( cd "$WT" && npm run -s store-assets:release-check ) || rc=$?; }
  if [ "$rc" = 0 ]; then ok "store art is ready for upload"; return 0; fi
  warn "the store-art check failed (missing native captures?): docs/store-assets/capture-plan.md"
  [ "$(ask_word "Type  keep-current-art  to build the stores with the screenshots they already have, or Enter to stop")" = keep-current-art ] || return 10
  st_w set storeArt kept-current
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
  local lp bad=""
  for lp in "$tmp"/FlagshipApp.xcarchive/Products/Applications/*.app/*.lproj/InfoPlist.strings; do
    [ -f "$lp" ] || continue
    bad+=$(plutil -convert json -o - "$lp" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const[k,v]of Object.entries(j))if(k===v||!v)console.log("  "+process.argv[1]+": "+k)' "$lp")
  done
  [ -z "$bad" ] || fail "permission prompts with no text (App Store Connect rejects them, ITMS-90738):
$bad"
  ok "every permission prompt has its text in every language"
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
  local gs="$MAIN_CHECKOUT/apps/mobile/android/app/google-services.json"
  if [ ! -f "$gs" ] || grep -q '"flagship-placeholder"' "$gs"; then
    err "apps/mobile/android/app/google-services.json in $MAIN_CHECKOUT is missing or the placeholder: the bundles would carry no Firebase config, so Android phones with Google Play services get no pushes (call rings included)."
    [ "$(ask_word "Type  no-fcm  to build without it anyway, or press Enter to stop and add the real file")" = no-fcm ] || return 10
  fi
  local links=(local.properties apps/mobile/android/local.properties apps/mobile/android/keystore/keystore.properties apps/mobile/android/app/google-services.json)
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
    say "  rate limits, last 30 days (refused sources = real people hit a budget; record the check date in AGENTS.md):"
    with_secret bash -c "cd '$WT' && npm run -s rate-limits -- --days 30" || warn "rate-limits did not answer: run it by hand (npm run rate-limits -- --days 30)"
  fi
  hdr "release-manifest (receipts and checks)"
  if wt_exists; then
    ( cd "$WT" && npm run -s release-manifest ) || { err "release-manifest lists blockers: each MISSING or STALE receipt is a real-device or production proof still owed"; PROBE_FAILS=$((PROBE_FAILS + 1)); }
  fi
  say "  Cloudflare Universal SSL on flagship.services must be OFF so the apex CAA lists only Let's Encrypt (dashboard -> SSL/TLS -> Edge Certificates). zone-health above fails on extra issuers."
  say "  Workers Paid: look at npm run ops -- workers --hours 72 in the days after the deploy."
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
   - certificate issuance: ISSUANCE_ACME_ACCOUNT_KEY on prod and gym; after boxes renew through the service, the
     account-pinned apex CAA (accounturi=<GET /api/certificates/account>; validationmethods=dns-01) and
     node scripts/issuance-inventory.mjs --before <switch day> [--revoke] (docs/runbooks/issuance-migration.md)
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

phase_open() { # steps of a phase that are neither done nor skipped (as numbers)
  local i id out=""
  for ((i = $(phase_first "$1"); i <= $(phase_last "$1"); i++)); do
    id=$(step_id "$i")
    if ! st_has done "$id" && ! st_has skipped "$id"; then out="$out $i"; fi
  done
  echo "${out# }"
}
phase_complete() { [ -z "$(phase_open "$1")" ]; }

run_steps() { # run_steps first last forced_first_flag phase
  local first=$1 last=$2 forced=$3 phase=$4 idx id rc stopped=0
  for ((idx = first; idx <= last; idx++)); do
    id=$(step_id "$idx")
    if [ "$DRY" = 1 ]; then show_meta "$idx" full; continue; fi
    if st_has done "$id" && ! { [ "$forced" = 1 ] && [ "$idx" = "$first" ]; }; then
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
      st_w add skipped "$id"; warn "step $idx skipped"; CURRENT_STEP=""; continue
    fi
    rc=0
    "run_$id" || rc=$?
    case "$rc" in
      0)  st_w add done "$id"; st_w del skipped "$id"; ok "step $idx done"; CURRENT_STEP="" ;;
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
    echo "Release plan: $n steps in two phases (A: sign, gate and deploy; B: the canary, the notice, the reap, the Studios, the stores)"
    echo "A re-pin (origin/main moved mid-run) keeps done steps done, except step $(step_index shellsig) (Sign the webapp shell), which"
    echo "re-opens when the webapp shell version moved; the gym gate only warns at the deploys."
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
    local i next=""; for ((i = 1; i <= n; i++)); do st_has done "$(step_id "$i")" || { next=$i; break; }; done
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
      phase=$(ask_word "Which phase? A (sign, gate and deploy) or B (the canary, the notice, the reap, the Studios, the stores) [A/B]")
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
        local i; for ((i = f; i <= l; i++)); do st_has done "$(step_id "$i")" || { f=$i; break; }; done
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
      [ "$(st_get phaseB)" = finished ] && fail "the state file belongs to a finished release (pinned $(short "$(st_get pinned)"), whose phase B is done: start this one with --new (the old file is kept aside), or name a step with --from N / --only N"
      f=$(phase_first "$phase")
      local i; for ((i = f; i <= l; i++)); do st_has done "$(step_id "$i")" || { f=$i; break; }; done
      if [ "$i" -gt "$l" ]; then say "phase $phase has every step recorded done. Use --new for a new release or --from N to redo a step."; exit 0; fi
    fi
  fi
  [ "$(step_phase "$f")" = "$phase" ] || fail "step $f belongs to phase $(step_phase "$f"), not $phase"
  run_steps "$f" "$l" "$forced_first" "$phase"
  CURRENT_STEP=""
  [ "$phase" = B ] && [ "$(st_get phaseB)" = finished ] && summary
  say "Done. Next: $( [ "$phase" = A ] && echo 'bash scripts/release.sh --phase B (after any planned device test)' || echo 'the manual items above' )"
}

if [ "${RELEASE_SOURCE_ONLY:-0}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi
main "$@"

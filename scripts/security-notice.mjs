#!/usr/bin/env node
// security-notice — mint the maintainer-signed notice every Flagship app shows
// (docs/security-notices.md). It is a thin, SAFE wrapper in the same spirit as
// scripts/endorse-release.mjs:
//
//   * PREVIEW by default: it builds the notice, checks every rule the apps
//     enforce, prints the exact canonical bytes and who would see what, and
//     writes nothing. Signing needs --sign.
//   * --sign signs with the maintainers CLI's signer (the ca-track YubiKey,
//     `yubikey-piv:slot=9c`), after a typed confirmation, and writes
//     .maintainers/notices/current.json (+ history/<seq>.json). It never takes
//     a PIN from argv or the environment.
//   * `required` (update-required) locks apps until they update. It is only
//     for a security reason, so it refuses without --advisory and
//     --security-reason, and the signed bytes carry both.
//
// Usage:
//   node scripts/security-notice.mjs maintenance --message "We will update Flagship on {date}. Your servers keep running, but flagshipserver.com may be briefly unavailable." --event 2026-10-21T09:00:00Z [--until ...] [--sign]
//   node scripts/security-notice.mjs advisory    --message "A new version has security fixes. Please update." --platform ios:12 --platform android:40 [--advisory FSA-2026-002]
//   node scripts/security-notice.mjs required    --message "You must update Flagship by {date}." --event 2026-11-01T00:00:00Z --lock-at 2026-11-01T00:00:00Z \
//        --platform ios:12 --platform android:40 --platform web:150 --deprecate-protocol 1 \
//        --advisory FSA-2026-001 --security-reason "A flaw in how a signed message is checked lets an attacker act as you."
//   node scripts/security-notice.mjs clear       (a signed all clear: supersedes the current notice)
//
//   --message <text>          shown to people; "{date}" becomes the local rendering of --event
//   --event <time>            the date the message talks about
//   --from <time>             first moment it is shown (default: now)
//   --until <time>            last moment (exclusive); at most 30 days after --from.
//                             default: maintenance = event + 1 day; others = from + 30 days
//   --platform <name>[:<minBuild>[:<minProtocol>]]   repeatable; ios | android | web.
//                             maintenance: a bare name limits it to that platform.
//   --lock-at <time|now>      required: when the lock starts ("now" = no grace window)
//   --deprecate-protocol <N>  required: boxes and .com stop accepting protocol N and lower at --lock-at
//                             (a platform given without a minProtocol then gets N+1)
//   --advisory <id>           the security advisory (required for `required`)
//   --security-reason <text>  one sentence (required for `required`)
//   --seq <N>                 default: one above the highest ever signed
//   --supersede-lock          needed to replace a lock that is still in force with a weaker notice
//   --allow-unshipped         let a minimum name a webapp build or protocol level that is not in this
//                             checkout (otherwise refused: nobody could ever satisfy it)
//   --signing-key <src>       default yubikey-piv:slot=9c (for a drill: file:/path/to/priv-hex)
//   --path <dir>              maintainers folder (default .maintainers)
//   --sign                    actually sign and write; omit for a preview
//
// <time> is ISO 8601 with a Z or offset, a date (UTC midnight), "now" or +30m / +6h / +7d.
//
// Exit codes: 0 ok, 1 error, 2 usage.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLIENT_PROTOCOL_LEVEL,
  MAINTAINER_PINNED_MANDATE_HASH,
  SECURITY_NOTICE_MAX_MESSAGE,
  SECURITY_NOTICE_MAX_REASON,
  SECURITY_NOTICE_MAX_WINDOW_MS,
  SecurityNoticeError,
  assembleSecurityNotice,
  canonicalSecurityNotice,
  securityNoticeOutcome,
  securityNoticeText,
  verifySecurityNotice,
} from "@flagship/protocol";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DAY = 24 * 3600_000;

export const KIND_BY_VERB = {
  maintenance: "maintenance",
  advisory: "update-advisory",
  required: "update-required",
  clear: "none",
};

export class UsageError extends Error {}

// ---- argument parsing ------------------------------------------------------

const VALUE_FLAGS = new Set([
  "message", "event", "from", "until", "platform", "lock-at", "deprecate-protocol",
  "advisory", "security-reason", "seq", "signing-key", "path",
]);
const BOOL_FLAGS = new Set(["sign", "supersede-lock", "allow-unshipped", "help"]);

export function parseArgs(argv) {
  const out = { verb: null, platform: [], sign: false, supersedeLock: false, allowUnshipped: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (out.verb !== null) throw new UsageError(`unexpected argument: ${a}`);
      out.verb = a;
      continue;
    }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (BOOL_FLAGS.has(name)) {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`);
      out[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
      }
      if (name === "platform") out.platform.push(value);
      else out[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else {
      throw new UsageError(`unknown flag: --${name}`);
    }
  }
  return out;
}

/** "now", "+6h", an ISO instant or a date → epoch ms. */
export function parseTime(raw, now, label) {
  const s = String(raw ?? "").trim();
  if (s === "now") return now;
  const rel = /^\+(\d+)([mhd])$/.exec(s);
  if (rel) return now + Number(rel[1]) * { m: 60_000, h: 3600_000, d: DAY }[rel[2]];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  throw new UsageError(`${label}: "${s}" is not a time (use 2026-10-21T09:00:00Z, a date, now or +7d)`);
}

function parsePlatforms(specs, kind, deprecateProtocol) {
  const out = {};
  for (const spec of specs) {
    const [name, build, proto, extra] = spec.split(":");
    if (!["ios", "android", "web"].includes(name) || extra !== undefined) {
      throw new UsageError(`--platform ${spec}: use ios, android or web, then :minBuild and optionally :minProtocol`);
    }
    if (out[name]) throw new UsageError(`--platform ${name} given twice`);
    const num = (v, what) => {
      if (v === undefined || v === "") return 0;
      if (!/^\d+$/.test(v)) throw new UsageError(`--platform ${spec}: ${what} must be a whole number`);
      return Number(v);
    };
    let minProtocol = num(proto, "minProtocol");
    if (proto === undefined && deprecateProtocol > 0 && kind === "update-required") minProtocol = deprecateProtocol + 1;
    out[name] = { minBuild: num(build, "minBuild"), minProtocol };
  }
  return out;
}

// ---- message lint (house style) ----------------------------------------------

/** Style problems that are errors (they would reach people) and warnings. */
export function lintText(text, label) {
  const errors = [];
  const warnings = [];
  if (/[–—]/.test(text)) errors.push(`${label}: no em dashes or en dashes; use a comma, a colon or two sentences`);
  if (/\p{Extended_Pictographic}/u.test(text)) errors.push(`${label}: no emoji`);
  if (text.trim() !== text) errors.push(`${label}: no leading or trailing spaces`);
  if (/[A-Z]{2,}\s+[A-Z]{2,}\s+[A-Z]{2,}/.test(text) || /!/.test(text)) warnings.push(`${label}: avoid shouting (capitals, exclamation marks); the sentence is read calmly`);
  if (text.length > 0 && !/^[A-Z0-9{]/.test(text)) warnings.push(`${label}: start with a capital letter (sentence case)`);
  if (text.length > 0 && !/[.?]$/.test(text)) warnings.push(`${label}: end with a full stop`);
  return { errors, warnings };
}

/** The webapp shell version this checkout ships (service-worker.js SHELL_VERSION), or 0. */
export function shippedWebBuild(repo = REPO) {
  try {
    const sw = fs.readFileSync(path.join(repo, "apps/web/public/webapp/service-worker.js"), "utf8");
    const m = /const SHELL_VERSION = "v(\d+)"/.exec(sw);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

// ---- the folder ----------------------------------------------------------------

export function noticesDir(root) {
  return path.join(root, "notices");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function readCurrent(root) {
  const v = readJson(path.join(noticesDir(root), "current.json"));
  return v && typeof v === "object" ? v : null;
}

/** The highest seq ever signed, read from current.json and history/. */
export function highestSignedSeq(root) {
  let max = 0;
  const cur = readCurrent(root);
  if (cur && Number.isSafeInteger(cur.seq)) max = cur.seq;
  const dir = path.join(noticesDir(root), "history");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)-/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

export function readCaMandates(root) {
  const dir = path.join(root, "tracks", "ca", "mandates");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson(path.join(dir, f)))
    .filter(Boolean);
}

/**
 * The key(s) the apps will accept a notice from at `now`: the ca-track
 * maintainer authority, walked forward from the baked pin exactly as an app
 * does. Empty when the chain does not reach `now`.
 */
export async function authorityKeysAt(root, now, maintainers) {
  const chain = maintainers.verifyMandateChainFromPin(MAINTAINER_PINNED_MANDATE_HASH, readCaMandates(root));
  const auth = maintainers.currentAuthority(chain, new Date(now));
  return auth ? [auth.holder] : [];
}

// ---- building the notice ---------------------------------------------------------

/**
 * Turn parsed arguments into a notice body, or throw a UsageError. Pure
 * apart from reading `root` for the next seq and the current notice.
 */
export function buildBody(args, { now, root }) {
  const kind = KIND_BY_VERB[args.verb];
  if (!kind) throw new UsageError(`first argument must be one of: ${Object.keys(KIND_BY_VERB).join(", ")}`);
  const errors = [];
  const warnings = [];

  const validFrom = args.from ? parseTime(args.from, now, "--from") : now;
  const eventAt = args.event ? parseTime(args.event, now, "--event") : 0;

  if (kind === "update-required") {
    if (!args.advisory) {
      throw new UsageError(
        "update-required locks people out until they update, and is only for a security reason: " +
          "give --advisory <id> (the advisory it answers) and --security-reason <one sentence>.",
      );
    }
    if (!args.securityReason) {
      throw new UsageError("update-required needs --security-reason <one sentence>: say what is wrong, in words a person can read.");
    }
    if (!args.lockAt) throw new UsageError('update-required needs --lock-at <time|now> ("now" means no grace window).');
  } else {
    if (args.securityReason && kind !== "update-advisory") throw new UsageError("--security-reason only goes with advisory or required");
    if (args.lockAt) throw new UsageError("--lock-at only goes with required");
    if (args.deprecateProtocol) throw new UsageError("--deprecate-protocol only goes with required");
  }
  if (kind === "none" && (args.message || args.platform.length || args.advisory || args.event)) {
    throw new UsageError("clear takes no message, platform, advisory or event");
  }

  let validUntil;
  if (args.until) validUntil = parseTime(args.until, now, "--until");
  else if (kind === "maintenance" && eventAt) validUntil = eventAt + DAY;
  else if (kind === "maintenance" || kind === "none") validUntil = validFrom + 7 * DAY;
  else validUntil = validFrom + SECURITY_NOTICE_MAX_WINDOW_MS;

  const deprecatesProtocol = args.deprecateProtocol ? Number(args.deprecateProtocol) : 0;
  if (args.deprecateProtocol && !(Number.isInteger(deprecatesProtocol) && deprecatesProtocol >= 1)) {
    throw new UsageError("--deprecate-protocol must be a whole number of 1 or more");
  }
  const platforms = parsePlatforms(args.platform, kind, deprecatesProtocol);
  const lockFrom = kind === "update-required" ? parseTime(args.lockAt, now, "--lock-at") : 0;
  const message = kind === "none" ? "" : String(args.message ?? "");
  const reason = kind === "update-required" || kind === "update-advisory" ? String(args.securityReason ?? "") : "";

  const seq = args.seq !== undefined ? Number(args.seq) : highestSignedSeq(root) + 1;
  if (!Number.isSafeInteger(seq) || seq < 1) throw new UsageError("--seq must be a whole number of 1 or more");
  const highest = highestSignedSeq(root);
  if (seq <= highest) errors.push(`seq ${seq} is not above ${highest}, the highest ever signed: apps ignore it as a rollback`);

  for (const [text, label] of [[message, "message"], [reason, "security reason"]]) {
    const l = lintText(text, label);
    errors.push(...l.errors);
    warnings.push(...l.warnings);
  }
  if (message.length > SECURITY_NOTICE_MAX_MESSAGE) errors.push(`message is ${message.length} characters; the limit is ${SECURITY_NOTICE_MAX_MESSAGE}`);
  if (reason.length > SECURITY_NOTICE_MAX_REASON) errors.push(`security reason is ${reason.length} characters; the limit is ${SECURITY_NOTICE_MAX_REASON}`);

  if (kind === "update-advisory" || kind === "update-required") {
    const web = shippedWebBuild(args.repo ?? REPO);
    const problems = [];
    for (const [name, m] of Object.entries(platforms)) {
      if (name === "web" && web > 0 && m.minBuild > web) {
        problems.push(`web minBuild ${m.minBuild} is above the webapp this checkout ships (${web}): no webapp could ever satisfy it`);
      }
      if (m.minProtocol > CLIENT_PROTOCOL_LEVEL) {
        problems.push(`${name} minProtocol ${m.minProtocol} is above the protocol level this checkout speaks (${CLIENT_PROTOCOL_LEVEL}): no build could ever satisfy it`);
      }
    }
    if (problems.length && !args.allowUnshipped) errors.push(...problems.map((p) => `${p} (--allow-unshipped if the build ships first)`));
    else warnings.push(...problems);
    for (const name of ["ios", "android"]) {
      if (platforms[name]) warnings.push(`${name}: confirm a store build at or above ${platforms[name].minBuild || "the protocol minimum"} is live before this reaches people`);
    }
  }

  const cur = readCurrent(root);
  if (cur && cur.kind === "update-required" && kind !== "update-required" && now >= cur.validFrom && now < cur.validUntil && !args.supersedeLock) {
    errors.push(
      `the notice in force (seq ${cur.seq}, ${cur.advisoryId}) is an update-required lock; this one replaces it and would unlock everyone. ` +
        "Restate the lock with `required`, or pass --supersede-lock if lifting it is the intent (`clear` is the all clear).",
    );
  }
  if (cur && validFrom > now + 60_000 && now >= cur.validFrom && now < cur.validUntil && cur.kind !== "none") {
    warnings.push(
      `it starts in the future, but replaces the notice in force (seq ${cur.seq}) the moment it is published: people see nothing until then. ` +
        "Start it now and put the date in the message instead.",
    );
  }
  if (kind === "update-required" && lockFrom - validFrom > 14 * DAY) {
    warnings.push("the grace window is over 14 days: while it runs the vulnerable path stays accepted (docs/security-notices.md \"Protocol versions\")");
  }
  if (kind === "update-required" && lockFrom > validFrom) {
    warnings.push("a grace window keeps the old protocol alive until the lock; use `--lock-at now` when the old path is itself the vulnerability");
  }

  const body = {
    seq, kind, validFrom, validUntil, eventAt, lockFrom, platforms,
    advisoryId: kind === "update-required" || kind === "update-advisory" ? String(args.advisory ?? "") : "",
    deprecatesProtocol, reason, message,
  };
  return { body, errors, warnings };
}

/** Throws a SecurityNoticeError naming the rule the protocol enforces, as a UsageError. */
export function canonicalOrExplain(body, signerPub) {
  try {
    return canonicalSecurityNotice(body, signerPub);
  } catch (e) {
    if (e instanceof SecurityNoticeError) throw new UsageError(`the apps would refuse this notice (${e.code}): ${RULE_TEXT[e.code] ?? e.code}`);
    throw e;
  }
}

const RULE_TEXT = {
  "window-too-long": "a notice is valid for at most 30 days",
  "window-order": "--until must be after --from",
  "advisory-required": "update-required needs --advisory",
  "reason-required": "update-required needs --security-reason",
  "platforms-required": "advisory and required need at least one --platform name:minBuild[:minProtocol]",
  "minimum-required": "every --platform on advisory and required needs a minBuild or a minProtocol above 0",
  "minimum-not-allowed": "maintenance takes bare platform names, no minimums",
  "bad-lock-from": "--lock-at must be inside the window: not before --from and before --until",
  "deprecates-not-enforced": "every platform's minProtocol must be above --deprecate-protocol, or old clients would not lock",
  "message-has-link": "no links in a notice; the apps supply their own store link",
  "bad-message": "the message is empty, too long, or has a | or a control character",
  "message-required": "give --message",
  "date-token-needs-event": "the message has {date} but there is no --event",
  "bad-event-at": "--event must be inside the window",
};

// ---- preview -------------------------------------------------------------------------

const fmt = (ms) => (ms ? new Date(ms).toISOString() : "(none)");

export function describeImpact(body, now) {
  const lines = [];
  const who = Object.keys(body.platforms).length ? Object.keys(body.platforms).join(", ") : "every app";
  switch (body.kind) {
    case "none":
      lines.push("Everyone: nothing shown. This supersedes the notice in force.");
      break;
    case "maintenance":
      lines.push(`${who}: a dismissible banner from ${fmt(body.validFrom)} until ${fmt(body.validUntil)}.`);
      break;
    case "update-advisory":
      for (const [p, m] of Object.entries(body.platforms)) {
        lines.push(`${p}: builds below ${m.minBuild || "-"} or protocol below ${m.minProtocol || "-"} get a dismissible "update" banner until ${fmt(body.validUntil)}.`);
      }
      break;
    case "update-required":
      for (const [p, m] of Object.entries(body.platforms)) {
        lines.push(
          `${p}: builds below ${m.minBuild || "-"} or protocol below ${m.minProtocol || "-"} ` +
            `${body.lockFrom <= now ? "are LOCKED from now" : `get the banner now and are LOCKED from ${fmt(body.lockFrom)}`}` +
            `, until ${fmt(body.validUntil)} at the latest.`,
        );
      }
      if (body.deprecatesProtocol) lines.push(`boxes and .com stop accepting protocol ${body.deprecatesProtocol} and lower at ${fmt(body.lockFrom)}.`);
      break;
  }
  return lines;
}

// ---- signing + writing -------------------------------------------------------------------

/**
 * Sign `body` with `signer` ({ pubKey, sign(bytes) -> hex }), check the
 * result the way an app will, and write current.json + history/<seq>.json.
 */
export async function signAndWrite({ body, signer, root, authorityKeys }) {
  const bytes = canonicalOrExplain(body, signer.pubKey);
  const signature = await signer.sign(bytes);
  const notice = assembleSecurityNotice(body, signer.pubKey, signature);
  const v = verifySecurityNotice(notice, authorityKeys);
  if (!v.ok) throw new Error(`the signed notice does not verify as the ca-track authority's (${v.reason}); nothing was written`);
  const dir = noticesDir(root);
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });
  const text = JSON.stringify(notice, null, 2) + "\n";
  fs.writeFileSync(path.join(dir, "history", `${String(notice.seq).padStart(4, "0")}-${notice.kind}.json`), text);
  fs.writeFileSync(path.join(dir, "current.json"), text);
  return notice;
}

export async function loadMaintainersCli() {
  const candidates = [
    process.env.FLAGSHIP_MAINTAINERS_DIR,
    path.join(REPO, "maintainers"),
    path.join(REPO, "..", "maintainers"),
  ].filter(Boolean);
  for (const dir of candidates) {
    const file = path.join(dir, "packages", "cli", "dist", "index.js");
    if (fs.existsSync(file)) {
      const cli = await import(pathToFileURL(file).href);
      const keysource = await import(pathToFileURL(path.join(dir, "packages", "cli", "dist", "lib", "keysource.js")).href);
      const ceremony = await import(pathToFileURL(path.join(dir, "packages", "cli", "dist", "lib", "ceremony.js")).href);
      return { cli, keysource, ceremony };
    }
  }
  return null;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  if (args.help || !args.verb) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    process.stdout.write(src.slice(1, src.findIndex((l, i) => i > 2 && !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return args.help ? 0 : 2;
  }

  const root = args.path ?? ".maintainers";
  const now = Date.now();
  const signingKey = args.signingKey ?? "yubikey-piv:slot=9c";

  let built;
  try {
    built = buildBody(args, { now, root });
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const { body, errors, warnings } = built;

  const maintainers = await import("@ibisllc/maintainers");
  const lib = await loadMaintainersCli();
  let signerPub = null;
  let signerNote = null;
  if (lib) {
    try {
      signerPub = (await lib.keysource.loadSignerBoundPubKey(signingKey)).toLowerCase();
    } catch (e) {
      signerNote = e instanceof Error ? e.message : String(e);
    }
  } else {
    signerNote = "maintainers CLI not found (set FLAGSHIP_MAINTAINERS_DIR to its clone, built)";
  }
  const authorityKeys = await authorityKeysAt(root, now, maintainers);

  let canonical = null;
  try {
    canonical = new TextDecoder().decode(canonicalOrExplain(body, signerPub ?? "0".repeat(64)));
  } catch (e) {
    errors.push(e.message);
  }

  const out = (s) => process.stdout.write(s + "\n");
  out("\n=== security-notice preview ===");
  out(`  kind:             ${body.kind}`);
  out(`  seq:              ${body.seq}`);
  out(`  shown:            ${fmt(body.validFrom)}  to  ${fmt(body.validUntil)} (exclusive)`);
  if (body.eventAt) out(`  date in message:  ${fmt(body.eventAt)}`);
  if (body.lockFrom) out(`  lock starts:      ${fmt(body.lockFrom)}${body.lockFrom <= now ? "  (already: no grace window)" : ""}`);
  if (body.advisoryId) out(`  advisory:         ${body.advisoryId}`);
  if (body.reason) out(`  security reason:  ${body.reason}`);
  if (body.message) out(`  message:          ${securityNoticeText(body, (ms) => new Date(ms).toUTCString())}`);
  out(`  signing key:      ${signingKey}`);
  out(`  signer pubkey:    ${signerPub ?? `(could not read: ${signerNote})`}`);
  out(`  ca authority now: ${authorityKeys.length ? authorityKeys.join(", ") : "(none: the apps would reject every notice)"}`);
  if (signerPub && authorityKeys.length) {
    out(`  signer matches:   ${authorityKeys.includes(signerPub) ? "yes" : "NO: apps would reject this key"}`);
  }
  out("\n  Who sees what:");
  for (const l of describeImpact(body, now)) out(`    ${l}`);
  if (canonical) {
    out(`\n  canonical bytes${signerPub ? "" : " (with an all-zero stand-in for the unreadable signer key)"}:\n    ${canonical}`);
  }
  for (const w of warnings) out(`\n  warning: ${w}`);
  for (const e of errors) out(`\n  ERROR: ${e}`);
  out("");

  if (errors.length) return 1;
  if (!args.sign) {
    out("DRY RUN: nothing signed, nothing written. Re-run with --sign to mint it.\n");
    return 0;
  }

  if (!lib) {
    process.stderr.write(`error: ${signerNote}\n`);
    return 1;
  }
  if (!signerPub || !authorityKeys.includes(signerPub)) {
    process.stderr.write("error: the signing key is not the current ca-track authority; the apps would reject the notice. Nothing signed.\n");
    return 1;
  }
  const phrase = body.kind === "update-required" ? "LOCK-USERS" : "NOTICE";
  if (body.kind === "update-required") {
    out("This LOCKS every app below the minimum, for a security reason, from the time above.");
    out("A mistake here is a denial of service on real people. Re-read the preview.");
  }
  const ok = await lib.ceremony.ttyConfirm({ ceremony: "security-notice", phrase }).catch(() => false);
  if (!ok) {
    process.stderr.write("aborted at the confirmation prompt: nothing was signed or written.\n");
    return 1;
  }
  out("Invoking the maintainers signer: approve the signature on your token when prompted...\n");
  const signer = await lib.keysource.loadSigner(signingKey, {
    pivTransport: lib.cli.defaultEnv.pivTransport,
    pivPin: lib.cli.defaultEnv.pivPin,
  });
  const notice = await signAndWrite({ body, signer, root, authorityKeys });
  try {
    execFileSync("git", ["add", path.join(root, "notices")], { stdio: "inherit" });
  } catch {
    /* the operator can add it by hand */
  }
  const o = securityNoticeOutcome(notice, { platform: "ios", build: 0, protocol: 0 }, now);
  out(`Done. seq ${notice.seq} written to ${path.join(root, "notices", "current.json")} (${o.action} for an old iOS build right now).`);
  out("Review and commit it, land it on main, then redeploy .com (`npm run deploy` in apps/com): the Worker bundles the file.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
      process.exit(1);
    },
  );
}

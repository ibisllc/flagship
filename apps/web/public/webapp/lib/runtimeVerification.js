// The server page's "Runtime" section (release plan G2): which Node.js the server runs, where it officially comes from,
// the checksum Flagship publishes for it at flagshipserver.com, the one the server computed from the running
// executable, and the state of Node's and Flagship's signatures. The server reports it on server-detail (`runtime`,
// packages/server-daemon/src/runtimeVerification.ts); this file only presents it. iOS (RuntimeVerificationModel.swift)
// and Android (RuntimeVerification.kt) pass the same vectors: packages/protocol/test-vectors/runtime-verification/.

import { tr } from "./i18n.js";

const PLATFORMS = { "linux-amd64": "Linux x86-64", "linux-arm64": "Linux ARM64" }; // i18n: keep

/** A usable view, or null for a server that does not report one. */
export function runtimeView(detail) {
  const v = detail?.runtime;
  if (!v || typeof v !== "object" || typeof v.version !== "string" || !v.flagship || typeof v.flagship.status !== "string") return null;
  return v;
}

export function platformLabel(target) {
  return PLATFORMS[target] ?? target;
}

/** "good" | "neutral" | "bad", and the line for Flagship's signature. */
export function flagshipStatus(v) {
  switch (v.flagship.status) {
    case "verified":
      return { tone: "good", label: tr("Verified") };
    case "not-published":
      return { tone: "neutral", label: tr("Not published yet") };
    case "unavailable":
      return { tone: "neutral", label: tr("Can't reach flagshipserver.com") };
    case "expired":
      return { tone: "bad", label: tr("Expired") };
    default:
      return { tone: "bad", label: tr("Refused") };
  }
}

export function upstreamStatus(v) {
  return v.upstream?.status === "verified-at-release"
    ? { tone: "good", label: tr("Checked when this release was built") }
    : { tone: "neutral", label: tr("Not checked") };
}

export function localStatus(v) {
  if (!v.localExecutableSha256) return { tone: "neutral", label: tr("Not checked") };
  return v.matchesLock ? { tone: "good", label: tr("Matches") } : { tone: "bad", label: tr("Does not match") };
}

/** Lines under the rows that need saying; each is a full sentence. */
export function runtimeNotes(v) {
  const notes = [];
  if (v.localExecutableSha256 && !v.matchesLock) notes.push({ tone: "bad", text: tr("This server runs a Node.js that is not the one its release locks.") });
  const s = v.flagship.status;
  if (!["verified", "not-published", "unavailable", "expired"].includes(s)) {
    notes.push({ tone: "bad", text: tr("Flagship's signed runtime manifest was refused ({0}).", s) });
  }
  if (s === "verified" && v.flagship.matchesLock === false) notes.push({ tone: "neutral", text: tr("This release locks a newer Node.js than the published manifest.") });
  return notes;
}

/** The commands for "Check it yourself": three groups, plain shell, the same on every client. */
export function runtimeCommands(v) {
  const sig = `${v.shasumsUrl.split("/").pop()}.sig`;
  const sums = v.shasumsUrl.split("/").pop();
  return [
    {
      title: tr("1. Node's signed checksum list"),
      text: [
        `curl -fsSLO ${v.officialUrl}`, // i18n: keep
        `curl -fsSLO ${v.shasumsUrl}`, // i18n: keep
        `curl -fsSLO ${v.shasumsUrl}.sig`, // i18n: keep
        `gpg --verify ${sig} ${sums}`, // i18n: keep
        `grep ' ${v.archiveFile}$' ${sums}`, // i18n: keep
        `sha256sum ${v.archiveFile}`, // i18n: keep
        `# ${v.expectedArchiveSha256}`,
      ].join("\n"),
    },
    {
      title: tr("2. Flagship's signed manifest"),
      text: [
        `curl -fsS ${v.manifestUrl} -o runtime-manifest.json`, // i18n: keep
        "jq -j .lockJson runtime-manifest.json | sha256sum",
        `# ${v.lockSha256}`,
        "git clone https://github.com/ibisllc/flagship && cd flagship && npm ci",
        "npx tsx tools/box-artifact/runtime-manifest.ts verify --manifest ../runtime-manifest.json",
      ].join("\n"),
    },
    {
      title: tr("3. On the server (with debug access on)"),
      text: [`sha256sum ${v.executablePath}`, `# ${v.expectedExecutableSha256}`, `${v.executablePath} --version`, `# v${v.version}`].join("\n"), // i18n: keep
    },
  ];
}

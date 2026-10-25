// Local AI on the owner's server (docs/architecture-v2/local-ai.md §4): the words the Local AI
// screen and the model menu show for what GET /api/screens/local-ai answers. Pure, so every
// check reads the same sentences the screen does.
//
// MIRRORS: iOS LocalAiScreen.swift, Android LocalAiScreen.kt.

import { fmtNum, tr, trn } from "./i18n.js";
import { formatBytes } from "./serverMonitoring.js";

export const LOCAL_AI_PATH = "/api/screens/local-ai";
export const PRIVACY_LINE = tr("Runs only on this server. Nothing is sent anywhere.");
export const COST_LINE = tr("Free: runs on this server");
export const LOCAL_GROUP_TITLE = tr("On this server");
export const NO_LOCAL_MODEL = tr("No model is downloaded on this server yet. Download one under Local AI.");

/** Whether the build menu should offer "On this server": at least one model is downloaded. */
export function localUsable(view) {
  return !!view && view.available !== false && Array.isArray(view.models) && view.models.some((m) => m?.state === "installed");
}

export function purposeLabel(purpose) {
  if (purpose === "build") return tr("Best for building apps");
  if (purpose === "chat") return tr("For app features");
  if (purpose === "test") return tr("For tests and fine-tuning");
  return "";
}

/** "about 24 tokens a second on this server (measured)" */
export function speedLine(model) {
  const s = model?.speed;
  if (!s || !(s.tokensPerSecond > 0)) return "";
  const n = fmtNum(s.tokensPerSecond, { maximumFractionDigits: s.tokensPerSecond < 10 ? 1 : 0 });
  const where = s.on === "gpu" ? tr("on this server's GPU") : tr("on this server's processor");
  return s.measured ? tr("About {0} tokens a second {1} (measured).", n, where) : tr("About {0} tokens a second {1} (estimate).", n, where);
}

/** Size, memory and whether it fits. */
export function sizeLine(model) {
  const size = formatBytes(model?.sizeBytes ?? 0);
  const mem = formatBytes((model?.memoryNeededMiB ?? 0) * 1024 * 1024);
  return model?.fits === false
    ? tr("{0} download · needs {1} of memory, more than this server has", size, mem)
    : tr("{0} download · needs {1} of memory", size, mem);
}

export function modelStateLine(model) {
  switch (model?.state) {
    case "downloading": {
      const p = model.progress;
      const pct = p && p.totalBytes > 0 ? Math.floor((p.receivedBytes / p.totalBytes) * 100) : 0;
      return tr("Downloading… {0}%", pct);
    }
    case "verifying":
      return tr("Checking the download…");
    case "installing":
      return tr("Installing…");
    case "installed":
      return tr("On this server");
    case "failed":
      return model.reason || tr("The download failed.");
    default:
      return "";
  }
}

/** Disk line: "52.0 GB free · models use 1.2 GB of 64.0 GB" */
export function diskLine(view) {
  const free = view?.hardware?.diskFreeBytes;
  const used = formatBytes(view?.budget?.usedBytes ?? 0);
  const budget = formatBytes(view?.budget?.budgetBytes ?? 0);
  return typeof free === "number"
    ? tr("{0} free on this server · models use {1} of {2}", formatBytes(free), used, budget)
    : tr("Models use {0} of {1}", used, budget);
}

export function hardwareLine(view) {
  const h = view?.hardware ?? {};
  const mem = formatBytes((h.memoryMiB ?? 0) * 1024 * 1024);
  return trn(h.cpus ?? 0, "{0} processor core · {1} of memory", "{0} processor cores · {1} of memory", mem);
}

/** "RTX 4090 (24.0 GB): in use by Local AI" */
export function gpuLine(gpu) {
  const name = `${gpu?.model ?? tr("GPU")} (${formatBytes((gpu?.memoryMiB ?? 0) * 1024 * 1024)})`;
  const holders = (gpu?.holders ?? []).map((h) => h.appName || h.appId).filter(Boolean);
  switch (gpu?.state) {
    case "in-use":
      return holders.length ? tr("{0}: in use by {1}", name, holders.join(", ")) : tr("{0}: in use", name);
    case "free":
      return tr("{0}: free", name);
    case "quarantined":
      return tr("{0}: set aside after a fault", name);
    default:
      return tr("{0}: not qualified for apps yet", name);
  }
}

export function jobStateLabel(state) {
  switch (state) {
    case "queued":
      return tr("Waiting");
    case "preparing":
      return tr("Preparing");
    case "starting":
      return tr("Starting");
    case "running":
      return tr("Running");
    case "stopping":
      return tr("Stopping");
    case "stopped":
      return tr("Stopped");
    case "completed":
      return tr("Done");
    case "cancelled":
      return tr("Cancelled");
    case "failed":
      return tr("Failed");
    default:
      return String(state ?? "");
  }
}

/** "On the GPU (0)" / "On the processor" / "" */
export function deviceLine(job) {
  if (job?.device === "gpu") {
    const ids = job.gpu?.deviceIds ?? [];
    return ids.length ? tr("On the GPU ({0})", ids.join(", ")) : tr("On the GPU");
  }
  if (job?.device === "cpu") return tr("On the processor");
  return "";
}

/** The queue position the box reported: "Next" / "3 ahead", or "". */
export function queueLine(job) {
  const p = job?.queuePosition;
  if (!(typeof p === "number" && p >= 1)) return "";
  if (p === 1) return tr("Next in line");
  return trn(p - 1, "{0} job ahead", "{0} jobs ahead");
}

export function jobTitle(job, modelName = (id) => id) {
  if (job?.kind === "inference") return tr("Model server: {0}", job.modelId ? modelName(job.modelId) : tr("no model"));
  return tr("Fine-tune {0} on {1}", modelName(job?.modelId ?? ""), job?.appName || job?.appId || "");
}

export function epochsLine(job) {
  if (job?.kind !== "training" || typeof job.epochs !== "number") return "";
  return tr("Epoch {0} of {1}", job.epochsDone ?? 0, job.epochs);
}

export function usageLine(app) {
  const g = app?.grant;
  const u = app?.usage ?? { requests: 0, tokens: 0 };
  if (!g) return tr("Not allowed to use the server's AI model.");
  return tr("Today: {0} of {1} requests, {2} of {3} tokens", fmtNum(u.requests ?? 0), fmtNum(g.requestsPerDay), fmtNum(u.tokens ?? 0), fmtNum(g.tokensPerDay));
}

export function checkpointLine(c) {
  const sha = String(c?.sha256 ?? "").slice(0, 12);
  const size = formatBytes(c?.sizeBytes ?? 0);
  return typeof c?.loss === "number"
    ? tr("Epoch {0} · {1} · {2}… · loss {3}", c?.epoch ?? 0, size, sha, fmtNum(c.loss, { maximumFractionDigits: 3 }))
    : tr("Epoch {0} · {1} · {2}…", c?.epoch ?? 0, size, sha);
}

/** Jobs a cancel / resume / delete applies to. */
export const jobActions = (job) => ({
  cancel: job?.kind === "training" && (job.state === "queued" || job.state === "preparing" || job.state === "running"),
  resume: job?.kind === "training" && (job.state === "cancelled" || job.state === "failed"),
  remove: job?.kind === "training" && (job.state === "completed" || job.state === "cancelled" || job.state === "failed"),
});

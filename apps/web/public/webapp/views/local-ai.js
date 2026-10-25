// The server page's "Local AI" (docs/architecture-v2/local-ai.md §4): the models this server can
// run (download, cancel, delete; size, memory, expected speed), the model server and its GPU, the
// job queue (what holds which GPU, where each job waits), fine-tuning on one app's staged sample
// data (a signed order), its checkpoints, and which apps may call the model (a signed grant with
// daily quotas). Everything here runs only on this server and costs nothing.
//
// MIRRORS: iOS LocalAiScreen.swift, Android LocalAiScreen.kt.

import { $, registerView, show } from "../lib/router.js";
import { boxClient } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";
import { inlineConfirm } from "../lib/modal.js";
import { toast } from "../lib/toast.js";
import { boxErrorText, humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";
import { tr } from "../lib/i18n.js";
import {
  COST_LINE,
  LOCAL_AI_PATH,
  PRIVACY_LINE,
  checkpointLine,
  deviceLine,
  diskLine,
  epochsLine,
  gpuLine,
  hardwareLine,
  jobActions,
  jobStateLabel,
  jobTitle,
  modelStateLine,
  purposeLabel,
  queueLine,
  sizeLine,
  speedLine,
  usageLine,
} from "../lib/localAi.js";
import { DEFAULT_APP_GRANT, LOCAL_AI_LIMITS, appGrantBody, newJobId, trainOrderBody, withdrawal } from "../lib/localAiOrders.js";

registerView("view-local-ai");

export const ADMIN_ONLY = tr("Only an admin device can change Local AI. This device can see it.");

let fqdn = "";
let backTo = "view-server-detail";
let current = null;
let pollTimer = null;
let detailJob = null;

const client = () => boxClient(fqdn);
const post = (path, body = {}) => client().fetch(`${LOCAL_AI_PATH}${path}`, { method: "POST", body: JSON.stringify(body) });

function errorText(e) {
  if (e && typeof e === "object" && ("status" in e || e.rateLimited)) return boxErrorText(e);
  return humanError(e);
}

const modelName = (id) => current?.models?.find((m) => m.id === id)?.name ?? id;

/** One model's card. Exported for tests. */
export function modelCardHtml(m, { canChange = true, serving = null } = {}) {
  const busy = m.state === "downloading" || m.state === "verifying" || m.state === "installing";
  const pct = m.progress && m.progress.totalBytes > 0 ? Math.floor((m.progress.receivedBytes / m.progress.totalBytes) * 100) : 0;
  const actions = !canChange
    ? ""
    : m.state === "installed"
      ? `<div class="row-2 mt-2">
          <button class="secondary" data-la-serve="${escapeHtml(m.id)}"${serving === m.id ? " disabled" : ""}>${serving === m.id ? tr("Serving") : tr("Serve this model")}</button>
          <button class="danger" data-la-delete="${escapeHtml(m.id)}">${tr("Delete")}</button>
        </div>`
      : busy
        ? `<button class="secondary full-width mt-2" data-la-cancel="${escapeHtml(m.id)}"${m.state === "downloading" ? "" : " disabled"}>${tr("Cancel download")}</button>`
        : `<button class="full-width mt-2" data-la-download="${escapeHtml(m.id)}"${m.fits === false ? " disabled" : ""}>${tr("Download")}</button>`;
  return `
    <div class="card mt-2" data-la-model="${escapeHtml(m.id)}">
      <div class="row"><strong>${escapeHtml(m.name)}</strong><span class="pill">${escapeHtml(purposeLabel(m.purpose))}</span></div>
      <p class="note small">${escapeHtml(m.descriptor ?? "")}</p>
      <p class="note small" data-la-size>${escapeHtml(sizeLine(m))}</p>
      <p class="note small" data-la-speed>${escapeHtml(speedLine(m))}</p>
      <p class="note small">${escapeHtml(tr("{0} parameters · {1} · license {2}", m.parameters ?? "", m.quantization ?? "", m.license?.id ?? ""))}</p>
      ${m.tools ? `<p class="note small">${tr("Can use tools, so it can build apps.")}</p>` : ""}
      ${m.trainable ? `<p class="note small">${tr("Can be fine-tuned on this server.")}</p>` : ""}
      ${busy ? `<progress class="full-width" max="100" value="${pct}" data-la-progress></progress>` : ""}
      ${m.state && m.state !== "available" ? `<p class="note small${m.state === "failed" ? " err-text" : ""}" data-la-state>${escapeHtml(modelStateLine(m))}</p>` : ""}
      ${actions}
    </div>`;
}

/** One job row. Exported for tests. */
export function jobRowHtml(job, { canChange = true } = {}) {
  const a = jobActions(job);
  const lines = [deviceLine(job), queueLine(job), epochsLine(job), job.reason ?? ""].filter(Boolean);
  return `
    <div class="card mt-2" data-la-job="${escapeHtml(job.id)}" data-la-kind="${escapeHtml(job.kind)}">
      <div class="row"><strong>${escapeHtml(jobTitle(job, modelName))}</strong><span class="pill" data-la-job-state>${escapeHtml(jobStateLabel(job.state))}</span></div>
      ${lines.map((l) => `<p class="note small">${escapeHtml(l)}</p>`).join("")}
      <p class="note small">${escapeHtml(COST_LINE)}</p>
      ${
        job.kind === "training"
          ? `<div class="row-2 mt-2">
              <button class="secondary" data-la-job-open="${escapeHtml(job.id)}">${tr("Checkpoints")}</button>
              ${canChange && a.cancel ? `<button class="danger" data-la-job-cancel="${escapeHtml(job.id)}">${tr("Cancel")}</button>` : ""}
              ${canChange && a.resume ? `<button data-la-job-resume="${escapeHtml(job.id)}">${tr("Resume")}</button>` : ""}
              ${canChange && a.remove ? `<button class="danger" data-la-job-delete="${escapeHtml(job.id)}">${tr("Delete")}</button>` : ""}
            </div>`
          : ""
      }
    </div>`;
}

function appGrantHtml(app, canChange) {
  const g = app.grant;
  const q = g ?? DEFAULT_APP_GRANT;
  return `
    <div class="card mt-2" data-la-app="${escapeHtml(app.serviceId)}">
      <div class="row"><strong>${escapeHtml(app.name)}</strong><span class="pill${g ? " ok" : ""}">${g ? tr("Allowed") : tr("Not allowed")}</span></div>
      <p class="note small" data-la-usage>${escapeHtml(usageLine(app))}</p>
      ${
        canChange
          ? `<label class="caption mt-2">${tr("Requests a day")}</label>
             <input type="number" class="full-width" min="1" max="${LOCAL_AI_LIMITS.requestsPerDay}" value="${q.requestsPerDay}" data-la-q-requests>
             <label class="caption mt-2">${tr("Tokens a day")}</label>
             <input type="number" class="full-width" min="1" max="${LOCAL_AI_LIMITS.tokensPerDay}" value="${q.tokensPerDay}" data-la-q-tokens>
             <label class="caption mt-2">${tr("Most tokens in one answer")}</label>
             <input type="number" class="full-width" min="1" max="${LOCAL_AI_LIMITS.maxTokensPerRequest}" value="${q.maxTokensPerRequest}" data-la-q-max>
             <div class="row-2 mt-2">
               <button data-la-grant="${escapeHtml(app.serviceId)}">${g ? tr("Save") : tr("Allow")}</button>
               ${g ? `<button class="danger" data-la-withdraw="${escapeHtml(app.serviceId)}">${tr("Withdraw")}</button>` : ""}
             </div>`
          : ""
      }
    </div>`;
}

function trainFormHtml(view, canChange) {
  const datasets = (view.datasets ?? []).filter((d) => d.hasSampleData);
  const bases = (view.trainableModels ?? []).filter((m) => m.installed);
  if (!canChange) return "";
  if (datasets.length === 0) return `<p class="note small" data-la-train-empty>${tr("No app has sample data to learn from yet. Attach sample data in one of its build chats first.")}</p>`;
  if (bases.length === 0) return `<p class="note small" data-la-train-empty>${tr("Download a model that can be fine-tuned first.")}</p>`;
  return `
    <label class="caption">${tr("App (its staged sample data only)")}</label>
    <select id="la-train-app" class="full-width">${datasets.map((d) => `<option value="${escapeHtml(d.serviceId)}">${escapeHtml(d.name)}</option>`).join("")}</select>
    <label class="caption mt-2">${tr("Base model")}</label>
    <select id="la-train-model" class="full-width">${bases.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("")}</select>
    <label class="caption mt-2">${tr("Epochs")}</label>
    <input id="la-train-epochs" type="number" class="full-width" min="1" max="${LOCAL_AI_LIMITS.epochs}" value="3">
    <button id="la-train-start" class="full-width mt-2">${tr("Start fine-tuning")}</button>
    <p class="note small mt-1">${tr("It learns only from the sample data you gave that app's test copy, never from the live app.")}</p>`;
}

/** The whole screen for one GET answer. Exported for tests. */
export function localAiHtml(view, { canChange = true } = {}) {
  if (!view) return `<div class="card placeholder">${tr("Loading…")}</div>`;
  if (view.available === false) {
    return `<div class="card"><p class="note" data-la-unavailable>${escapeHtml(view.reason || tr("Local AI isn't available on this server."))}</p></div>`;
  }
  const serving = view.service?.modelId ?? view.settings?.serveModel ?? null;
  const svc = view.service ?? { state: "stopped" };
  const gpus = view.hardware?.gpus ?? [];
  return `
    <div class="card" data-la-privacy>
      <p class="note">${escapeHtml(PRIVACY_LINE)}</p>
      <p class="note small">${escapeHtml(COST_LINE)}</p>
      <p class="note small" data-la-hardware>${escapeHtml(hardwareLine(view))}</p>
      <p class="note small" data-la-disk>${escapeHtml(diskLine(view))}</p>
      ${gpus.map((g) => `<p class="note small" data-la-gpu="${escapeHtml(g.id)}">${escapeHtml(gpuLine(g))}</p>`).join("")}
      ${gpus.length === 0 ? `<p class="note small">${tr("This server has no GPU it can use; models run on its processor.")}</p>` : ""}
      ${canChange ? "" : `<p class="note small" data-la-admin-only>${escapeHtml(ADMIN_ONLY)}</p>`}
    </div>

    <h2 class="mt-4">${tr("Model server")}</h2>
    <div class="card" data-la-service>
      <div class="row"><span class="label">${tr("Status")}</span><span class="pill" data-la-service-state>${escapeHtml(jobStateLabel(svc.state))}</span></div>
      ${svc.modelId ? `<p class="note small">${escapeHtml(modelName(svc.modelId))}</p>` : ""}
      ${deviceLine(svc) ? `<p class="note small">${escapeHtml(deviceLine(svc))}</p>` : ""}
      ${queueLine(svc) ? `<p class="note small">${escapeHtml(queueLine(svc))}</p>` : ""}
      ${svc.reason ? `<p class="note small err-text">${escapeHtml(svc.reason)}</p>` : ""}
      ${
        canChange
          ? `<label class="row mt-2"><input type="checkbox" id="la-use-gpu"${view.settings?.useGpu !== false ? " checked" : ""}> <span>${tr("Use a GPU when one is free")}</span></label>
             <div class="row-2 mt-2">
               <button id="la-service-start"${svc.state === "running" ? " disabled" : ""}>${tr("Start")}</button>
               <button class="secondary" id="la-service-stop"${svc.state === "running" || svc.state === "starting" ? "" : " disabled"}>${tr("Stop")}</button>
             </div>`
          : ""
      }
    </div>

    <h2 class="mt-4">${tr("Models")}</h2>
    <div data-la-models>${(view.models ?? []).map((m) => modelCardHtml(m, { canChange, serving })).join("")}</div>

    <h2 class="mt-4">${tr("Jobs")}</h2>
    <div data-la-jobs>${(view.jobs ?? []).length ? view.jobs.map((j) => jobRowHtml(j, { canChange })).join("") : `<p class="note small">${tr("Nothing is running or waiting.")}</p>`}</div>

    <h2 class="mt-4">${tr("Fine-tune a model")}</h2>
    <div class="card" data-la-train>${trainFormHtml(view, canChange)}</div>

    <h2 class="mt-4">${tr("Apps that may use the model")}</h2>
    <div data-la-apps>${(view.apps ?? []).length ? view.apps.map((a) => appGrantHtml(a, canChange)).join("") : `<p class="note small">${tr("No app on this server asks to use the model.")}</p>`}</div>`;
}

/** A training job's detail: its checkpoints. Exported for tests. */
export function jobDetailHtml(detail) {
  const cps = detail?.checkpoints ?? [];
  return `
    <div class="card" data-la-detail="${escapeHtml(detail?.job?.id ?? "")}">
      <strong>${escapeHtml(jobTitle(detail?.job ?? {}, modelName))}</strong>
      <p class="note small">${escapeHtml(jobStateLabel(detail?.job?.state))}</p>
      ${cps.length ? cps.map((c) => `<p class="note small mono" data-la-checkpoint>${escapeHtml(checkpointLine(c))}</p>`).join("") : `<p class="note small">${tr("No checkpoints yet.")}</p>`}
      <button class="secondary full-width mt-2" id="la-detail-close">${tr("Close")}</button>
    </div>`;
}

const signer = () => (bytes) => sensitiveSigner()(getSession()?.umk, bytes);

/** Allow (or change) an app's quotas: sign and send. Returns the box's answer. */
export async function submitAppGrant({ serverDomain, serviceId, quotas, issuedAt = Date.now() }, deps = {}) {
  const body = await appGrantBody({ serverDomain, serviceId, ...quotas, issuedAt }, deps.sign ?? signer());
  return await (deps.post ?? post)("/apps/grant", body);
}

/** Withdraw an app's access: all quotas 0, signed. */
export async function submitWithdraw({ serverDomain, serviceId, issuedAt = Date.now() }, deps = {}) {
  const body = await appGrantBody(withdrawal(serverDomain, serviceId, issuedAt), deps.sign ?? signer());
  return await (deps.post ?? post)("/apps/grant", body);
}

/** Start a fine-tuning job: a fresh job id, signed. */
export async function submitTrain({ serverDomain, serviceId, baseModel, epochs, issuedAt = Date.now(), jobId = newJobId() }, deps = {}) {
  const body = await trainOrderBody({ serverDomain, serviceId, jobId, baseModel, epochs, issuedAt }, deps.sign ?? signer());
  return await (deps.post ?? post)("/train", body);
}

const intOf = (el, min, max, dflt) => {
  const n = Math.floor(Number(el?.value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

async function act(btn, go, done) {
  if (btn) btn.disabled = true;
  try {
    await go();
    if (done) toast(done, "ok");
  } catch (e) {
    toast(errorText(e), "err");
  } finally {
    if (btn) btn.disabled = false;
    await render();
  }
}

function wire(root) {
  const q = (sel) => root.querySelectorAll(sel);
  q("[data-la-download]").forEach((b) => b.addEventListener("click", () => act(b, () => post("/models/download", { modelId: b.getAttribute("data-la-download") }), tr("Download started."))));
  q("[data-la-cancel]").forEach((b) => b.addEventListener("click", () => act(b, () => post("/models/cancel", { modelId: b.getAttribute("data-la-cancel") }))));
  q("[data-la-serve]").forEach((b) => b.addEventListener("click", () => act(b, () => post("/settings", { serveModel: b.getAttribute("data-la-serve") }), tr("This model will serve next."))));
  q("[data-la-delete]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.getAttribute("data-la-delete");
      const ok = await inlineConfirm({ title: tr("Delete {0}?", modelName(id)), message: tr("It is removed from this server. You can download it again later."), okLabel: tr("Delete"), danger: true });
      if (ok) await act(b, () => post("/models/delete", { modelId: id }));
    }),
  );
  $("la-use-gpu")?.addEventListener("change", (ev) => act(null, () => post("/settings", { useGpu: ev.target.checked })));
  $("la-service-start")?.addEventListener("click", (ev) => act(ev.currentTarget, () => post("/service/start", {}), tr("The model server is running.")));
  $("la-service-stop")?.addEventListener("click", (ev) => act(ev.currentTarget, () => post("/service/stop", {})));
  q("[data-la-job-cancel]").forEach((b) => b.addEventListener("click", () => act(b, () => post("/jobs/cancel", { jobId: b.getAttribute("data-la-job-cancel") }))));
  q("[data-la-job-resume]").forEach((b) => b.addEventListener("click", () => act(b, () => post("/jobs/resume", { jobId: b.getAttribute("data-la-job-resume") }), tr("Resumed from the last checkpoint."))));
  q("[data-la-job-delete]").forEach((b) => b.addEventListener("click", () => act(b, () => post("/jobs/delete", { jobId: b.getAttribute("data-la-job-delete") }))));
  q("[data-la-job-open]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        detailJob = await client().fetch(`${LOCAL_AI_PATH}/jobs/${encodeURIComponent(b.getAttribute("data-la-job-open"))}`);
      } catch (e) {
        toast(errorText(e), "err");
      }
      paint();
    }),
  );
  $("la-detail-close")?.addEventListener("click", () => {
    detailJob = null;
    paint();
  });
  $("la-train-start")?.addEventListener("click", (ev) =>
    act(
      ev.currentTarget,
      () =>
        submitTrain({
          serverDomain: client().fqdn,
          serviceId: $("la-train-app").value,
          baseModel: $("la-train-model").value,
          epochs: intOf($("la-train-epochs"), 1, LOCAL_AI_LIMITS.epochs, 3),
        }),
      tr("Fine-tuning queued."),
    ),
  );
  q("[data-la-grant]").forEach((b) => {
    const card = b.closest("[data-la-app]");
    b.addEventListener("click", () =>
      act(
        b,
        () =>
          submitAppGrant({
            serverDomain: client().fqdn,
            serviceId: b.getAttribute("data-la-grant"),
            quotas: {
              requestsPerDay: intOf(card?.querySelector("[data-la-q-requests]"), 1, LOCAL_AI_LIMITS.requestsPerDay, DEFAULT_APP_GRANT.requestsPerDay),
              tokensPerDay: intOf(card?.querySelector("[data-la-q-tokens]"), 1, LOCAL_AI_LIMITS.tokensPerDay, DEFAULT_APP_GRANT.tokensPerDay),
              maxTokensPerRequest: intOf(card?.querySelector("[data-la-q-max]"), 1, LOCAL_AI_LIMITS.maxTokensPerRequest, DEFAULT_APP_GRANT.maxTokensPerRequest),
            },
          }),
        tr("The app may use the model."),
      ),
    );
  });
  q("[data-la-withdraw]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await inlineConfirm({ title: tr("Withdraw access?"), message: tr("The app can no longer call this server's model."), okLabel: tr("Withdraw"), danger: true });
      if (ok) await act(b, () => submitWithdraw({ serverDomain: client().fqdn, serviceId: b.getAttribute("data-la-withdraw") }), tr("Access withdrawn."));
    }),
  );
}

function busy(view) {
  return (
    (view?.models ?? []).some((m) => ["downloading", "verifying", "installing"].includes(m.state)) ||
    (view?.jobs ?? []).some((j) => ["queued", "preparing", "running", "starting"].includes(j.state))
  );
}

function paint() {
  const host = $("local-ai-content");
  if (!host) return;
  host.innerHTML = (detailJob ? jobDetailHtml(detailJob) : "") + localAiHtml(current, { canChange: canSignAdminOrders() });
  wire(host);
}

async function render() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  try {
    current = await client().fetch(LOCAL_AI_PATH);
  } catch (e) {
    const host = $("local-ai-content");
    if (host) host.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(errorText(e))}</p></div>`;
    return;
  }
  paint();
  if (busy(current) && !$("view-local-ai")?.classList.contains("hidden")) pollTimer = setTimeout(() => void render(), 2000);
}

/** Open Local AI for one server. */
export function enterLocalAi(serverFqdn, { back = "view-server-detail" } = {}) {
  fqdn = String(serverFqdn ?? "");
  backTo = back;
  current = null;
  detailJob = null;
  show("view-local-ai");
  paint();
  void render();
}

/** The server page's entry card. */
export function localAiEntryHtml() {
  return `
    <h2 class="mt-4">${tr("Local AI")}</h2>
    <div class="card" id="local-ai-entry">
      <p class="note">${escapeHtml(PRIVACY_LINE)}</p>
      <button id="local-ai-open" class="full-width mt-2">${tr("Models, jobs and fine-tuning")}</button>
    </div>`;
}

export function wireLocalAiEntry(serverFqdn) {
  $("local-ai-open")?.addEventListener("click", () => enterLocalAi(serverFqdn));
}

export function initLocalAiView() {
  $("local-ai-back")?.addEventListener("click", () => {
    if (pollTimer) clearTimeout(pollTimer);
    show(backTo);
  });
}

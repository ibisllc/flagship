// "Choose your own account name": the screen at sign-up and the wiring of lib/chooseName.js to this browser's keys,
// `.com` and the card rail. The logic (and why it is shaped this way) is in lib/chooseName.js.

import {
  bytesToHex,
  deriveAccountDeviceKeyFromSeed,
  deriveAccountDeviceSeedFromSeed,
  deriveAccountIdFromSeed,
  moveProfileKeys,
  persistAccountDeviceSeed,
  signWithAdminRoot,
  signWithIrk,
} from "../keystore.js";
import { signedDirectoryFetch, updateAccountDisplayName, updateSelfDisplayName } from "../lib/accountDirectory.js";
import { decryptProfile, deriveAccountProfileKey, deriveDeviceDirectoryKey } from "../lib/accountMetadata.js";
import { clearAccountReadTokens, mintAccountReadToken } from "../lib/accountRead.js";
import {
  claimChosenName,
  clearNameChoice,
  forgetNameGrant,
  loadNameChoice,
  ADDRESS_PREFIX,
  localNameProblem,
  nameChoiceRefusalText,
  resumeNameChoice,
  saveNameChoice,
  stripAddressPrefix,
} from "../lib/chooseName.js";
import { toast } from "../lib/toast.js";
import { isAdminRootKey, isLockedKey } from "../lib/keyCustody.js";
import { ensureHost, buildOverlay } from "../lib/modal.js";
import { buyWithStripe, consumeShopReturn, finishShopOrders, loadPaymentsConfig, loadWallet, updateWallet } from "../lib/plan.js";
import { getActiveProfile, renameProfile } from "../lib/profiles.js";
import { renameProfileRecord } from "../lib/profilesStore.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { markVouchersSpent, takeVouchers, voucherNullifier } from "../lib/vouchers.js";
import { tr } from "../lib/i18n.js";

/**
 * The screen. Resolves to `{name, method: "pay"}`, `{name, method: "code", code}`, `{keep: true}` (only when
 * `keepName` is given: the account exists already) or null (Back).
 */
export function inlineChooseOwnName({ initialName = "", error = "", keepName = "", setAside = false, free = false } = {}) {
  return new Promise((resolve) => {
    const host = ensureHost();
    const overlay = buildOverlay();
    overlay.innerHTML = `
      <div class="modal-card" role="document">
        <h3 class="modal-title">${tr("Choose your own account name")}</h3>
        <label class="label" for="choose-name-input">${tr("Account name")}</label>
        <div class="input-prefixed" dir="ltr">
          <span class="input-prefix" aria-hidden="true">${ADDRESS_PREFIX}</span>
          <input id="choose-name-input" type="text" data-choose-name autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="30" value="${escapeHtml(initialName)}" ${free ? "readonly" : ""} />
        </div>
        ${setAside ? `<p class="note mt-2">${tr("This name has been set aside for you.")}</p>` : ""}
        <p class="warn-text mt-2" data-choose-problem role="alert" ${error ? "" : "hidden"}>${escapeHtml(error)}</p>
        ${free
          ? `<div class="row-2 mt-3"><button data-choose-free>${tr("Continue")}</button></div>`
          : `<p class="note mt-2">${tr("Your own account name costs $10.")}</p>
        <div class="row-2 mt-3">
          <button data-choose-pay>${tr("Pay $10")}</button>
          <button class="secondary" data-choose-voucher>${tr("Use a voucher")}</button>
        </div>`}
        <div class="mt-3" data-choose-code-row hidden>
          <label class="label" for="choose-name-code">${tr("Voucher code")}</label>
          <input id="choose-name-code" data-choose-code autocomplete="off" autocapitalize="characters" spellcheck="false" />
          <button class="full-width mt-2" data-choose-use>${tr("Use voucher")}</button>
        </div>
        <div class="row-2 mt-3">
          ${keepName
            ? `<button class="secondary" data-choose-keep>${escapeHtml(tr("Keep {0}", keepName))}</button>`
            : `<button class="secondary" data-choose-back>${tr("Back")}</button>`}
        </div>
      </div>
    `;
    host.appendChild(overlay);
    document.body.classList.add("modal-open");
    const nameEl = overlay.querySelector("[data-choose-name]");
    const problemEl = overlay.querySelector("[data-choose-problem]");
    const codeRow = overlay.querySelector("[data-choose-code-row]");
    const codeEl = overlay.querySelector("[data-choose-code]");
    const close = (v) => {
      overlay.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(keepName ? { keep: true } : null); }
    };
    const name = () => String(nameEl.value ?? "").trim().toLowerCase();
    const check = () => {
      const p = name() ? localNameProblem(name()) : null;
      problemEl.textContent = p ?? "";
      problemEl.hidden = !p;
      return !p && !!name();
    };
    // A pasted address keeps only the name (the prefix is shown, never typed). maxlength would cut a long paste
    // before this sees it, so a paste is read whole.
    const setName = (v) => {
      const bare = stripAddressPrefix(v);
      if (bare !== nameEl.value) nameEl.value = bare.slice(0, 30);
    };
    nameEl.addEventListener("paste", (ev) => {
      const text = ev.clipboardData?.getData("text");
      if (text == null) return;
      ev.preventDefault();
      const start = nameEl.selectionStart ?? nameEl.value.length;
      const end = nameEl.selectionEnd ?? start;
      setName(nameEl.value.slice(0, start) + stripAddressPrefix(text.trim()) + nameEl.value.slice(end));
      check();
    });
    nameEl.addEventListener("input", () => {
      setName(nameEl.value);
      check();
    });
    overlay.querySelector("[data-choose-free]")?.addEventListener("click", () => {
      if (check()) close({ name: name(), method: "grant" });
    });
    overlay.querySelector("[data-choose-pay]")?.addEventListener("click", () => {
      if (check()) close({ name: name(), method: "pay" });
    });
    overlay.querySelector("[data-choose-voucher]")?.addEventListener("click", () => {
      codeRow.hidden = false;
      codeEl.focus();
    });
    overlay.querySelector("[data-choose-use]").addEventListener("click", () => {
      const code = String(codeEl.value ?? "").trim();
      if (check() && code) close({ name: name(), method: "code", code });
    });
    overlay.querySelector("[data-choose-keep]")?.addEventListener("click", () => close({ keep: true }));
    overlay.querySelector("[data-choose-back]")?.addEventListener("click", () => close(null));
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => nameEl.focus({ preventScroll: true }));
  });
}

/** One open of the admin root for the whole choice (one passkey prompt, not one per signature). */
function adminSigner(session) {
  let opened = null;
  return {
    async open() {
      const key = session.adminRootSeed;
      if (!isAdminRootKey(key)) throw new Error("administrator key unavailable");
      if (isLockedKey(key) && !opened) opened = await key.open();
    },
    async sign(bytes) {
      await this.open();
      return signWithAdminRoot(opened?.edSeed ?? session.adminRootSeed, bytes);
    },
    seed() {
      return opened?.edSeed ?? (isLockedKey(session.adminRootSeed) ? null : session.adminRootSeed);
    },
    wipe() {
      opened?.edSeed?.fill(0);
      opened?.mldsaSeed?.fill(0);
      opened = null;
    },
  };
}

/** This browser's side of lib/chooseName.js. */
export async function liveChooseNameIo(session = getSession()) {
  const admin = adminSigner(session);
  const umk = session.umk;
  const cfg = async () => (await loadPaymentsConfig()).config;
  return {
    admin,
    session,
    storage: globalThis.localStorage,
    fetch: (...a) => globalThis.fetch(...a),
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    aidPubHex: bytesToHex((await deriveAccountIdFromSeed(umk)).publicKey),
    irkPubHex: bytesToHex(session.irk.publicKey),
    signAdmin: (bytes) => admin.sign(bytes),
    signIrk: (bytes) => signWithIrk(umk, bytes),
    deriveAccountDeviceSeed: deriveAccountDeviceSeedFromSeed,
    deriveAccountDeviceKey: deriveAccountDeviceKeyFromSeed,
    persistAccountDeviceSeed,
    async reputProfiles({ oldName, newName, profile }) {
      const r = await signedDirectoryFetch(`/api/accounts/${encodeURIComponent(newName)}/directory`, { method: "GET" }, { session, profile });
      if (!r.ok) throw new Error(`directory (${r.status})`);
      const body = await r.json();
      const read = async (rec, recordType, key) => {
        for (const accountId of [newName, oldName]) {
          try {
            return { name: await decryptProfile({ ...rec, accountId, recordType }, key), under: accountId };
          } catch {
            /* the other name */
          }
        }
        return null;
      };
      await admin.open();
      const signing = { ...session, adminRootSeed: admin.seed() ?? session.adminRootSeed };
      if (body.accountProfile) {
        const n = await read(body.accountProfile, "account-profile", await deriveAccountProfileKey(umk));
        if (n && n.under === oldName) {
          const res = await updateAccountDisplayName(n.name, { revision: body.accountProfile.revision }, { session: signing, profile });
          if (res && res.ok === false) throw new Error("account profile");
        }
      }
      const self = (body.selfProfiles ?? []).find((p) => p.deviceId === profile.deviceId);
      if (self) {
        const n = await read(self, "device-self-profile", await deriveDeviceDirectoryKey(umk));
        if (n && n.under === oldName) await updateSelfDisplayName(n.name, { revision: self.revision }, { session, profile });
      }
    },
    async moveLocalAccount(oldName, newName) {
      await moveProfileKeys(oldName, newName);
      renameProfile(oldName, newName);
      renameProfileRecord(oldName, newName);
      session.username = newName;
    },
    async mintReadToken(newName) {
      clearAccountReadTokens();
      await mintAccountReadToken(newName).catch(() => null);
    },
    buyPack: (units) => buyWithStripe(units),
    navigate: (url) => globalThis.location.assign(url),
    consumeShopReturn: () => consumeShopReturn(),
    finishShopOrders: () => finishShopOrders(),
    async takeVouchers(n) {
      const { wallet } = await loadWallet(await cfg());
      return takeVouchers(wallet, n);
    },
    voucherNullifier,
    async dropSpentVouchers(nullifiers) {
      await updateWallet(await cfg(), (w) => markVouchersSpent(w, nullifiers)).catch(() => null);
    },
  };
}

/** Runs the choice with the live wiring; the admin root is closed again whatever happens. */
export async function runChosenName(rec) {
  const io = await liveChooseNameIo();
  try {
    return await claimChosenName(rec, io);
  } finally {
    io.admin.wipe();
  }
}

/** After an unlock: finish or drop a choice this browser left (lib/chooseName.js resumeNameChoice). */
export async function resumeChosenName() {
  const session = getSession();
  if (!(session?.umk instanceof Uint8Array) || !session?.username || !getActiveProfile()) return null;
  const io = await liveChooseNameIo(session);
  try {
    return await resumeNameChoice(io);
  } finally {
    io.admin.wipe();
  }
}

/**
 * The rename half of "Choose your own account name", with the screen back for a name or code the person can fix
 * (`keepName` offers to keep the current name instead). Resolves to `{name}` (the account's name now) or
 * `{redirected: true}` (off to the card payment; the choice resumes after the unlock).
 */
export async function finishChosenName(rec) {
  const kept = rec.suggested;
  for (;;) {
    toast(tr("Setting up your account name…"));
    let out;
    try {
      out = await runChosenName(rec);
    } catch (e) {
      console.error(e);
      const left = loadNameChoice();
      if (left && (left.stage === "renaming" || left.stage === "settling")) {
        // `.com` may already know the new name: finish now if we can, else at the next unlock.
        toast(tr("Finishing your account name…"));
        const resumed = await resumeChosenName().catch(() => null);
        if (resumed?.ok) {
          toast(tr("Your account is now {0}.", resumed.name), "ok");
          return { name: resumed.name };
        }
        return { name: getSession()?.username ?? kept };
      }
      clearNameChoice();
      out = {
        ok: false,
        fixable: false,
        refusal: nameChoiceRefusalText({}, { kept, paidWith: rec.method === "code" ? "code" : null, existing: rec.existing === true }),
      };
    }
    if (out.redirected) return { redirected: true };
    if (out.ok) {
      toast(tr("Your account is now {0}.", out.name), "ok");
      return { name: out.name };
    }
    if (out.fixable) {
      const free = !!rec.grant?.paid && rec.grant.name === rec.wanted;
      const again = await inlineChooseOwnName({ initialName: rec.wanted, error: out.refusal, keepName: kept, setAside: !!rec.grant, free });
      if (again && !again.keep) {
        rec = { ...rec, wanted: again.name, method: again.method, code: again.code, stage: "quote" };
        saveNameChoice(rec);
        continue;
      }
      clearNameChoice();
      if (!rec.existing) toast(tr("Account created — {0}", kept), "ok");
      return { name: kept };
    }
    if (out.refusal) toast(out.refusal, "err");
    return { name: kept };
  }
}

/**
 * A name-grant link opened on an account that already exists. The rename works there only while this browser is
 * the account's one device (every other device's key and grant are signed over the current name); `.com` refuses
 * the rest (a voi.ci page, a server, quantum-safe keys), and then the person is told to open the link when they
 * create their account.
 */
export async function enterNameGrantForAccount(grant) {
  const session = getSession();
  const profile = getActiveProfile();
  const current = String(session?.username ?? "").toLowerCase();
  if (!(session?.umk instanceof Uint8Array) || !current || !profile?.deviceId) return;
  const elsewhere = () => toast(tr("Open this link when you create your account."), "err");
  let grants = [];
  try {
    const r = await signedDirectoryFetch(`/api/accounts/${encodeURIComponent(current)}/directory`, { method: "GET" }, { session, profile });
    if (!r.ok) return elsewhere();
    const body = await r.json();
    const live = (body.devices ?? []).filter((d) => d.revokedAt == null);
    if (live.length !== 1 || live[0].deviceId !== profile.deviceId) {
      forgetNameGrant();
      return elsewhere();
    }
    grants = (body.grants ?? []).filter((g) => g.deviceId === profile.deviceId).map((g) => g.grantId);
  } catch {
    return elsewhere();
  }
  const choice = await inlineChooseOwnName({ initialName: grant.name, setAside: true, free: grant.paid, keepName: current });
  if (!choice || choice.keep) return;
  const done = await finishChosenName({
    suggested: current, wanted: choice.name, method: choice.method, code: choice.code, grant,
    stage: "quote", deviceId: profile.deviceId, oldGrantIds: grants, existing: true,
  });
  if (!done.redirected && done.name === grant.name) forgetNameGrant();
}

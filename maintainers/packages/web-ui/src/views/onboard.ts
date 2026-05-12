/**
 * Onboarding wizard — 7 steps from "what's your project?" through
 * "commit to your repo".
 *
 * Each step is a pure function: (state, store, deps) → HTMLElement.
 * The store handles state transitions; views never directly call
 * adapter or webauthn — they go through deps so tests can stub them.
 */

import {
  buildGenesisMandate,
  buildKeyFile,
  makeGenesisPolicy,
  makeTrackPolicy,
  serializeEnvelope,
  serializeJson,
  pathForKeyFile,
  pathForMandate,
  pathForTrackPolicy,
  PATH_ROOT_POLICY,
  randomUuid,
} from "../envelopes.js";
import { el, mount } from "../dom.js";
import type { OnboardStep, StateStore } from "../state.js";
import {
  type MaintainerIdentity,
  enrollMaintainerIdentity,
  randomChallenge,
} from "../webauthn.js";
import type { Pubkey } from "@maintainers/protocol";

export interface OnboardDeps {
  enrollIdentity?: (opts: {
    rpId: string;
    rpName: string;
    userName: string;
    userDisplayName: string;
  }) => Promise<MaintainerIdentity>;
}

export function renderOnboard(
  step: OnboardStep,
  root: HTMLElement,
  store: StateStore,
  deps: OnboardDeps = {},
): void {
  const state = store.get();
  const stepper = renderStepper(step);
  let body: HTMLElement;
  switch (step) {
    case "project":
      body = stepProject(store);
      break;
    case "yubikey":
      body = stepYubikey(store, deps);
      break;
    case "name-key":
      body = stepNameKey(store);
      break;
    case "cadence":
      body = stepCadence(store);
      break;
    case "successor":
      body = stepSuccessor(store, deps);
      break;
    case "review":
      body = stepReview(store);
      break;
    case "commit":
      body = stepCommit(store);
      break;
    case "done":
      body = stepDone(store);
      break;
  }
  mount(
    root,
    el(
      "div.onboard",
      null,
      el("h1", null, "Set up maintainers for your project"),
      el(
        "p.muted",
        null,
        "This page writes one folder, `.maintainers/`, into your repo. After that, anyone who clones the repo can verify cryptographically who is allowed to sign releases for it.",
      ),
      stepper,
      body,
      state.error ? el("div.alert.err", null, state.error) : null,
    ),
  );
}

const STEPS: { id: OnboardStep; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "yubikey", label: "Yubikey" },
  { id: "name-key", label: "Name" },
  { id: "cadence", label: "Cadence" },
  { id: "successor", label: "Successor" },
  { id: "review", label: "Review" },
  { id: "commit", label: "Commit" },
];

function renderStepper(active: OnboardStep): HTMLElement {
  const activeIdx = STEPS.findIndex((s) => s.id === active);
  return el(
    "div.stepper",
    null,
    ...STEPS.map((s, i) => {
      const cls = i < activeIdx ? "step done" : i === activeIdx ? "step active" : "step";
      return el(`div.${cls.replace(" ", ".")}`, null, `${i + 1}. ${s.label}`);
    }),
  );
}

// ---- Step 1: project URL ----------------------------------------------------

function stepProject(store: StateStore): HTMLElement {
  const draft = store.get().draft;
  let value = draft.repoUrl;
  const input = el("input", {
    type: "url",
    placeholder: "github.com/your/repo",
    value,
    onInput: (e: Event) => {
      value = (e.target as HTMLInputElement).value;
    },
  });
  return el(
    "div.panel",
    null,
    el("h2", null, "What's your project?"),
    el(
      "p.muted",
      null,
      "Paste the URL of the repository you want to add maintainers to. Works with GitHub, Codeberg, GitLab, and Forgejo.",
    ),
    el("label", null, "Repository URL"),
    input,
    el("p.hint", null, "Example: github.com/sindresorhus/got"),
    el(
      "div.row.end",
      null,
      el(
        "button.primary",
        {
          onClick: () => {
            if (!value.trim()) {
              store.update({ error: "Enter a repository URL to continue." });
              return;
            }
            store.update({ error: null });
            store.patchDraft({ repoUrl: value.trim() });
            store.update({ route: { kind: "onboard", step: "yubikey" } });
          },
        },
        "Continue",
      ),
    ),
  );
}

// ---- Step 2: Yubikey enrollment ---------------------------------------------

function stepYubikey(store: StateStore, deps: OnboardDeps): HTMLElement {
  const state = store.get();
  const draft = state.draft;
  return el(
    "div.panel",
    null,
    el("h2", null, "Plug in your Yubikey"),
    el(
      "p.muted",
      null,
      "Touch the key when it blinks. We'll create a new credential on the key and use it to derive your signing identity. The signing key never leaves the Yubikey unless you touch it.",
    ),
    el(
      "p.hint",
      null,
      "No Yubikey on hand? Any FIDO2 security key with PRF support works (recent YubiKey 5, Solo 2, NitroKey 3). Pick a real key for a real project; a software fallback is available below for testing.",
    ),
    draft.identity
      ? el(
          "div.alert.ok",
          null,
          "Got it. Your pubkey: ",
          el("span.pubkey", null, draft.identity.pubKey),
        )
      : null,
    el(
      "div.row",
      null,
      el(
        "button.primary",
        {
          onClick: async () => {
            store.update({ error: null, loading: true });
            try {
              const enroller =
                deps.enrollIdentity ??
                ((o) =>
                  enrollMaintainerIdentity({
                    rpId: state.rpId,
                    rpName: state.rpName,
                    userId: randomChallenge(),
                    userName: o.userName,
                    userDisplayName: o.userDisplayName,
                    challenge: randomChallenge(),
                  }));
              const id = await enroller({
                rpId: state.rpId,
                rpName: state.rpName,
                userName: `holder-${randomUuid().slice(0, 8)}@${draft.repoUrl}`,
                userDisplayName: draft.repoUrl,
              });
              store.patchDraft({ identity: id });
              store.update({ loading: false });
            } catch (e) {
              store.update({
                loading: false,
                error: `Couldn't enroll Yubikey: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          },
          disabled: state.loading || !!draft.identity,
        },
        draft.identity ? "Enrolled" : state.loading ? "Touch the key…" : "Enroll Yubikey",
      ),
    ),
    el(
      "div.row.end",
      null,
      el(
        "button",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "project" } }),
        },
        "Back",
      ),
      el(
        "button.primary",
        {
          disabled: !draft.identity,
          onClick: () => store.update({ route: { kind: "onboard", step: "name-key" } }),
        },
        "Continue",
      ),
    ),
  );
}

// ---- Step 3: name the key ---------------------------------------------------

function stepNameKey(store: StateStore): HTMLElement {
  const draft = store.get().draft;
  let displayName = draft.displayName;
  let email = draft.email;
  return el(
    "div.panel",
    null,
    el("h2", null, "Name this key"),
    el(
      "p.muted",
      null,
      "Other people who see your signatures will see this name and email. You can rotate the email later without rotating the key.",
    ),
    el("label", null, "Display name"),
    el("input", {
      type: "text",
      placeholder: "Jane Doe",
      value: displayName,
      onInput: (e: Event) => {
        displayName = (e.target as HTMLInputElement).value;
      },
    }),
    el("label", null, "Email"),
    el("input", {
      type: "email",
      placeholder: "jane@example.com",
      value: email,
      onInput: (e: Event) => {
        email = (e.target as HTMLInputElement).value;
      },
    }),
    el(
      "div.row.end",
      null,
      el(
        "button",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "yubikey" } }),
        },
        "Back",
      ),
      el(
        "button.primary",
        {
          onClick: () => {
            if (!displayName.trim() || !email.trim()) {
              store.update({ error: "Both name and email are required." });
              return;
            }
            if (!/.+@.+\..+/.test(email)) {
              store.update({ error: "That doesn't look like an email address." });
              return;
            }
            store.update({ error: null });
            store.patchDraft({ displayName: displayName.trim(), email: email.trim() });
            store.update({ route: { kind: "onboard", step: "cadence" } });
          },
        },
        "Continue",
      ),
    ),
  );
}

// ---- Step 4: cadence --------------------------------------------------------

function stepCadence(store: StateStore): HTMLElement {
  const draft = store.get().draft;
  const options: { days: 30 | 60 | 90 | 180; label: string; hint: string }[] = [
    { days: 30, label: "30 days", hint: "Highest discipline; renew monthly." },
    { days: 60, label: "60 days", hint: "Recommended default." },
    { days: 90, label: "90 days", hint: "Quarterly renewal." },
    { days: 180, label: "180 days", hint: "Lowest friction; longer compromise window." },
  ];
  return el(
    "div.panel",
    null,
    el("h2", null, "How often will you renew?"),
    el(
      "p.muted",
      null,
      "Your mandate expires after this many days. Before it expires, touch your Yubikey to renew it. If you forget, a designated successor can take over.",
    ),
    el(
      "div.cadence-options",
      null,
      ...options.map((o) =>
        el(
          `button${draft.cadenceDays === o.days ? ".selected" : ""}`,
          {
            onClick: () => store.patchDraft({ cadenceDays: o.days }),
          },
          el("div", null, o.label),
          el("div.hint", null, o.hint),
        ),
      ),
    ),
    el(
      "div.row.end",
      null,
      el(
        "button",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "name-key" } }),
        },
        "Back",
      ),
      el(
        "button.primary",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "successor" } }),
        },
        "Continue",
      ),
    ),
  );
}

// ---- Step 5: successor ------------------------------------------------------

function stepSuccessor(store: StateStore, deps: OnboardDeps): HTMLElement {
  const state = store.get();
  const draft = state.draft;
  let pubKeyInput = draft.successor.pubKey ?? "";
  let succName = draft.successor.displayName ?? "";
  let succEmail = draft.successor.email ?? "";
  return el(
    "div.panel",
    null,
    el("h2", null, "Designate a successor (recommended)"),
    el(
      "p.muted",
      null,
      "If you don't renew before your mandate expires — say, your Yubikey is lost or you get hit by a bus — a successor you name here can sign new mandates without you. They cannot act before expiry; they hold standing only after the clock runs out.",
    ),
    el(
      "div.row",
      null,
      el(
        `button${draft.successorMode === "enroll" ? ".selected.primary" : ""}`,
        {
          onClick: () => store.patchDraft({ successorMode: "enroll" }),
        },
        "Enroll their Yubikey here",
      ),
      el(
        `button${draft.successorMode === "paste" ? ".selected.primary" : ""}`,
        {
          onClick: () => store.patchDraft({ successorMode: "paste" }),
        },
        "Paste their pubkey",
      ),
      el(
        `button${draft.successorMode === "skip" ? ".selected.primary" : ""}`,
        {
          onClick: () => store.patchDraft({ successorMode: "skip" }),
        },
        "Skip for now",
      ),
    ),
    draft.successorMode === "paste"
      ? el(
          "div",
          null,
          el("label", null, "Successor pubkey (64 hex characters)"),
          el("textarea", {
            placeholder: "abcd1234… (64 hex chars)",
            value: pubKeyInput,
            onInput: (e: Event) => {
              pubKeyInput = (e.target as HTMLTextAreaElement).value.trim();
            },
          }),
          el("label", null, "Successor display name (optional)"),
          el("input", {
            type: "text",
            value: succName,
            onInput: (e: Event) => {
              succName = (e.target as HTMLInputElement).value;
            },
          }),
          el("label", null, "Successor email (optional)"),
          el("input", {
            type: "email",
            value: succEmail,
            onInput: (e: Event) => {
              succEmail = (e.target as HTMLInputElement).value;
            },
          }),
        )
      : null,
    draft.successorMode === "enroll"
      ? el(
          "div",
          null,
          el(
            "p.muted",
            null,
            "Have the successor plug their Yubikey into this machine and touch it. They'll need to be physically present.",
          ),
          el("label", null, "Successor display name"),
          el("input", {
            type: "text",
            value: succName,
            onInput: (e: Event) => {
              succName = (e.target as HTMLInputElement).value;
            },
          }),
          el("label", null, "Successor email"),
          el("input", {
            type: "email",
            value: succEmail,
            onInput: (e: Event) => {
              succEmail = (e.target as HTMLInputElement).value;
            },
          }),
          el(
            "div.row",
            null,
            el(
              "button.primary",
              {
                disabled: state.loading,
                onClick: async () => {
                  store.update({ error: null, loading: true });
                  try {
                    const enroller =
                      deps.enrollIdentity ??
                      (() =>
                        enrollMaintainerIdentity({
                          rpId: state.rpId,
                          rpName: state.rpName,
                          userId: randomChallenge(),
                          userName: succEmail || `successor-${randomUuid().slice(0, 8)}`,
                          userDisplayName: succName || "Successor",
                          challenge: randomChallenge(),
                        }));
                    const id = await enroller({
                      rpId: state.rpId,
                      rpName: state.rpName,
                      userName: succEmail || `successor-${randomUuid().slice(0, 8)}`,
                      userDisplayName: succName || "Successor",
                    });
                    store.patchDraft({
                      successor: {
                        pubKey: id.pubKey,
                        displayName: succName,
                        email: succEmail,
                        identity: id,
                      },
                    });
                    store.update({ loading: false });
                  } catch (e) {
                    store.update({
                      loading: false,
                      error: `Couldn't enroll successor Yubikey: ${e instanceof Error ? e.message : String(e)}`,
                    });
                  }
                },
              },
              draft.successor.pubKey ? "Re-enroll successor" : "Enroll successor Yubikey",
            ),
          ),
          draft.successor.pubKey
            ? el(
                "div.alert.ok",
                null,
                "Successor enrolled: ",
                el("span.pubkey", null, draft.successor.pubKey),
              )
            : null,
        )
      : null,
    el(
      "div.row.end",
      null,
      el(
        "button",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "cadence" } }),
        },
        "Back",
      ),
      el(
        "button.primary",
        {
          onClick: () => {
            if (draft.successorMode === "paste") {
              if (!/^[0-9a-f]{64}$/.test(pubKeyInput)) {
                store.update({
                  error: "Successor pubkey must be exactly 64 lower-case hex characters.",
                });
                return;
              }
              store.patchDraft({
                successor: {
                  pubKey: pubKeyInput,
                  displayName: succName.trim() || undefined,
                  email: succEmail.trim() || undefined,
                },
              });
            }
            store.update({ error: null, route: { kind: "onboard", step: "review" } });
          },
        },
        "Continue",
      ),
    ),
  );
}

// ---- Step 6: review ---------------------------------------------------------

function stepReview(store: StateStore): HTMLElement {
  const draft = store.get().draft;
  const successors = collectSuccessors(draft);
  return el(
    "div.panel",
    null,
    el("h2", null, "Review and sign"),
    el(
      "p.muted",
      null,
      "Confirm the details below. When you click Sign, your Yubikey will sign a genesis mandate and your key file. Nothing is committed yet — the next step downloads or pushes them to your repo.",
    ),
    el(
      "table",
      null,
      el(
        "tbody",
        null,
        row("Repository", draft.repoUrl),
        row("Holder name", draft.displayName),
        row("Holder email", draft.email),
        row("Holder pubkey", draft.identity?.pubKey ?? "(missing)"),
        row("Renewal cadence", `${draft.cadenceDays} days`),
        row(
          "Successors",
          successors.length === 0 ? "(none)" : successors.length === 1 ? "1 designated" : `${successors.length} designated`,
        ),
      ),
    ),
    el(
      "div.row.end",
      null,
      el(
        "button",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "successor" } }),
        },
        "Back",
      ),
      el(
        "button.primary",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "commit" } }),
        },
        "Sign and continue",
      ),
    ),
  );
}

function row(k: string, v: string): HTMLElement {
  return el(
    "tr",
    null,
    el("th", null, k),
    el(
      "td",
      null,
      v.length > 24 && /^[0-9a-f]+$/.test(v) ? el("span.pubkey", null, v) : v,
    ),
  );
}

// ---- Step 7: commit ---------------------------------------------------------

function stepCommit(store: StateStore): HTMLElement {
  const state = store.get();
  const draft = state.draft;
  const adapter = state.adapter;
  return el(
    "div.panel",
    null,
    el("h2", null, "Commit to your repo"),
    el(
      "p.muted",
      null,
      adapter.canCommit
        ? "We'll push the new `.maintainers/` files to your repo right now."
        : "We'll bundle the files into a ZIP. Unzip it at the root of your repo, then `git add .maintainers && git commit`.",
    ),
    state.draft.committedSha
      ? el("div.alert.ok", null, `Already committed: ${state.draft.committedSha.slice(0, 12)}…`)
      : state.draft.downloadFilename
        ? el("div.alert.ok", null, `Bundle downloaded: ${state.draft.downloadFilename}`)
        : null,
    state.error ? el("div.alert.err", null, state.error) : null,
    el(
      "div.row.end",
      null,
      el(
        "button",
        {
          onClick: () => store.update({ route: { kind: "onboard", step: "review" } }),
        },
        "Back",
      ),
      el(
        "button.primary",
        {
          disabled: state.loading,
          onClick: async () => {
            await performCommit(store);
          },
        },
        adapter.canCommit ? "Push to repo" : "Download ZIP",
      ),
    ),
  );
}

// ---- Step 8: done -----------------------------------------------------------

function stepDone(store: StateStore): HTMLElement {
  const state = store.get();
  const draft = state.draft;
  return el(
    "div.panel",
    null,
    el(
      "div.alert.ok",
      null,
      draft.committedSha
        ? `Pushed to your repo. Commit SHA: ${draft.committedSha.slice(0, 12)}.`
        : "Bundle ready. Download it below.",
    ),
    draft.downloadFilename
      ? el("p", null, `Downloaded: ${draft.downloadFilename}`)
      : null,
    el(
      "p",
      null,
      "From now on, anyone who clones your repo can verify the chain. You can review the project's health on this page anytime.",
    ),
    el(
      "div.row.end",
      null,
      el(
        "button.primary",
        {
          onClick: () =>
            store.update({
              route: { kind: "project", repoUrl: draft.repoUrl, view: "health" },
            }),
        },
        "Go to project dashboard",
      ),
    ),
  );
}

function collectSuccessors(draft: ReturnType<StateStore["get"]>["draft"]): Pubkey[] {
  if (draft.successorMode === "skip") return [];
  if (draft.successor.pubKey) return [draft.successor.pubKey];
  return [];
}

async function performCommit(store: StateStore): Promise<void> {
  const state = store.get();
  const draft = state.draft;
  if (!draft.identity) {
    store.update({ error: "Holder identity missing; go back to step 2." });
    return;
  }
  store.update({ loading: true, error: null });
  try {
    const now = state.now;
    const track = "release";
    const successors = collectSuccessors(draft);
    const rootPolicy = makeGenesisPolicy(deriveProjectName(draft.repoUrl), [track]);
    const trackPolicy = makeTrackPolicy(track, draft.cadenceDays);
    const mandate = buildGenesisMandate({
      holderPub: draft.identity.pubKey,
      holderPriv: draft.identity.privKey,
      holderDisplayName: draft.displayName,
      holderEmail: draft.email,
      successors,
      track,
      now,
      durationDays: draft.cadenceDays,
    });
    const keyFile = buildKeyFile({
      pub: draft.identity.pubKey,
      priv: draft.identity.privKey,
      displayName: draft.displayName,
      email: draft.email,
      introductionMandate: mandate.mandateId,
    });
    const entries = [
      { path: PATH_ROOT_POLICY, envelope: keyFile, bytes: serializeJson(rootPolicy) },
      // Use TrackPolicy envelope placeholder (TrackPolicy isn't a signed envelope; we
      // serialize as JSON.) The adapter only uses .envelope for non-bytes paths; pass
      // the keyfile as a stand-in since adapter.submitBundle currently uses bytes only.
      { path: pathForTrackPolicy(track), envelope: keyFile, bytes: serializeJson(trackPolicy) },
      { path: pathForMandate(track, mandate.issuedAt, "genesis"), envelope: mandate, bytes: serializeEnvelope(mandate) },
      { path: pathForKeyFile(draft.email), envelope: keyFile, bytes: serializeEnvelope(keyFile) },
    ];
    // If a successor key file is available (enrolled flow with name/email), include it.
    if (
      draft.successorMode === "enroll" &&
      draft.successor.identity &&
      draft.successor.email &&
      draft.successor.displayName
    ) {
      const succKeyFile = buildKeyFile({
        pub: draft.successor.identity.pubKey,
        priv: draft.successor.identity.privKey,
        displayName: draft.successor.displayName,
        email: draft.successor.email,
        introductionMandate: mandate.mandateId,
      });
      entries.push({
        path: pathForKeyFile(draft.successor.email),
        envelope: succKeyFile,
        bytes: serializeEnvelope(succKeyFile),
      });
    }
    const result = await state.adapter.submitBundle({
      repoUrl: draft.repoUrl,
      entries,
      message: "maintainers: genesis",
    });
    if (result.kind === "committed") {
      store.patchDraft({ committedSha: result.sha });
    } else {
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      store.patchDraft({ downloadFilename: result.filename });
    }
    store.update({ loading: false, route: { kind: "onboard", step: "done" } });
  } catch (e) {
    store.update({
      loading: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function deriveProjectName(repoUrl: string): string {
  // Strip scheme, take final path component.
  const stripped = repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  const parts = stripped.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? repoUrl;
}

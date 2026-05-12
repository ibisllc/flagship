/**
 * Takeover flow — only visible when a track's most-recent mandate has
 * expired AND the user holds a credential listed in that mandate's
 * successors.
 *
 * UI: explain who's about to be replaced, then one click → WebAuthn
 * assertion → sign a new mandate naming the asserter as the new holder.
 */

import { lastExpiredMandate, verifyTrack } from "@maintainers/protocol";
import {
  buildTakeoverMandate,
  pathForMandate,
  serializeEnvelope,
} from "../envelopes.js";
import { el, mount, relativeTime, shortHex } from "../dom.js";
import { lookupHolder } from "../parse-folder.js";
import type { StateStore } from "../state.js";
import { assertAndDerive, randomChallenge } from "../webauthn.js";

export interface TakeoverDeps {
  assertIdentity?: (opts: { rpId: string; credentialId: string }) => Promise<{ pubKey: string; privKey: string }>;
}

export function renderTakeover(
  repoUrl: string,
  trackName: string,
  root: HTMLElement,
  store: StateStore,
  deps: TakeoverDeps = {},
): void {
  const state = store.get();
  const loaded = state.loaded;
  if (!loaded) {
    mount(root, el("div.panel", null, el("p", null, "Project not loaded.")));
    return;
  }
  const track = loaded.folder.tracks.find((t) => t.name === trackName);
  if (!track || !track.policy) {
    mount(root, el("div.alert.err", null, "Track not found or missing policy."));
    return;
  }
  const verified = verifyTrack(trackName, track.policy, track.mandates);
  const expired = lastExpiredMandate(verified, state.now);
  if (!expired) {
    mount(
      root,
      el(
        "div.panel",
        null,
        el("h2", null, "Nothing to take over"),
        el(
          "p",
          null,
          "This track's mandate is currently active. Renew it instead.",
        ),
      ),
    );
    return;
  }
  if (expired.successors.length === 0) {
    mount(
      root,
      el(
        "div.alert.err",
        null,
        "The expired mandate named no successors. Takeover requires a successor; you'll need to coordinate with the prior holder out-of-band.",
      ),
    );
    return;
  }
  const prevHolder = lookupHolder(loaded.folder, expired.holder);
  let credIdInput = "";
  let cadenceDays: 30 | 60 | 90 | 180 = 60;

  const draw = (): void => {
    mount(
      root,
      el(
        "div.panel",
        null,
        el("h1", null, `Take over the ${trackName} mandate`),
        el(
          "div.alert.warn",
          null,
          prevHolder
            ? `${prevHolder.displayName} <${prevHolder.email}>'s mandate expired ${relativeTime(expired.expiresAt, state.now)}.`
            : `The previous mandate (held by ${shortHex(expired.holder)}) expired ${relativeTime(expired.expiresAt, state.now)}.`,
        ),
        el(
          "p",
          null,
          "You are listed as a successor. Touch your Yubikey to take over.",
        ),
        el("h3", null, "Named successors"),
        ...expired.successors.map((s) => {
          const h = lookupHolder(loaded.folder, s);
          return el(
            "p",
            null,
            h ? `${h.displayName} <${h.email}> ` : "",
            el("span.pubkey", null, shortHex(s)),
          );
        }),
        el("label", null, "Your credential id (base64url; optional)"),
        el("input", {
          type: "text",
          placeholder: "leave blank to be prompted by the browser",
          value: credIdInput,
          onInput: (e: Event) => {
            credIdInput = (e.target as HTMLInputElement).value.trim();
          },
        }),
        el("label", null, "New mandate duration"),
        el(
          "div.cadence-options",
          null,
          ...([30, 60, 90, 180] as const).map((d) =>
            el(
              `button${cadenceDays === d ? ".selected" : ""}`,
              {
                onClick: () => {
                  cadenceDays = d;
                  draw();
                },
              },
              `${d} days`,
            ),
          ),
        ),
        store.get().error ? el("div.alert.err", null, store.get().error!) : null,
        el(
          "div.row.end",
          null,
          el(
            "button",
            {
              onClick: () =>
                store.update({ route: { kind: "project", repoUrl, view: "health" } }),
            },
            "Cancel",
          ),
          el(
            "button.primary",
            {
              disabled: store.get().loading,
              onClick: async () => {
                store.update({ loading: true, error: null });
                try {
                  const asserter =
                    deps.assertIdentity ??
                    ((o) =>
                      assertAndDerive({
                        rpId: o.rpId,
                        credentialId: o.credentialId,
                        challenge: randomChallenge(),
                      }).then((id) => ({ pubKey: id.pubKey, privKey: id.privKey })));
                  const id = await asserter({
                    rpId: state.rpId,
                    credentialId: credIdInput || expired.successors[0]!,
                  });
                  if (!expired.successors.includes(id.pubKey)) {
                    throw new Error(
                      "the credential you used is not in the successors list of the expired mandate",
                    );
                  }
                  const mandate = buildTakeoverMandate({
                    successorPub: id.pubKey,
                    successorPriv: id.privKey,
                    newSuccessors: expired.successors,
                    track: trackName,
                    now: state.now,
                    durationDays: cadenceDays,
                  });
                  const result = await state.adapter.submitEnvelope({
                    repoUrl,
                    path: pathForMandate(trackName, mandate.issuedAt, "takeover"),
                    envelope: mandate,
                    bytes: serializeEnvelope(mandate),
                  });
                  if (result.kind === "downloadable") {
                    const url = URL.createObjectURL(result.blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = result.filename;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 30_000);
                  }
                  store.update({ loading: false, route: { kind: "project", repoUrl, view: "health" } });
                } catch (e) {
                  store.update({
                    loading: false,
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              },
            },
            state.adapter.canCommit ? "Sign & push takeover" : "Sign & download takeover",
          ),
        ),
      ),
    );
  };

  draw();
}

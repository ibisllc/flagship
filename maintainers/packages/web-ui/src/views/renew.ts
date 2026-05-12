/**
 * Renewal flow — invoked when the holder of an active mandate wants to
 * extend their authority before expiry.
 *
 * UI: one click → WebAuthn assertion → derive Ed25519 → sign a new
 * mandate that keeps the same successors → submit through the adapter.
 */

import { currentAuthority, verifyTrack } from "@maintainers/protocol";
import {
  buildRenewalMandate,
  pathForMandate,
  serializeEnvelope,
} from "../envelopes.js";
import { el, mount, daysFromNow } from "../dom.js";
import type { StateStore } from "../state.js";
import { assertAndDerive, randomChallenge } from "../webauthn.js";

export interface RenewDeps {
  assertIdentity?: (opts: { rpId: string; credentialId: string }) => Promise<{ pubKey: string; privKey: string }>;
}

export function renderRenew(
  repoUrl: string,
  trackName: string,
  root: HTMLElement,
  store: StateStore,
  deps: RenewDeps = {},
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
  const auth = currentAuthority(verified, state.now);
  if (!auth) {
    mount(
      root,
      el(
        "div.panel",
        null,
        el("h2", null, "No active mandate"),
        el(
          "p",
          null,
          "This track has no active mandate to renew. If a previous mandate has expired, a successor can take over instead.",
        ),
      ),
    );
    return;
  }
  const days = daysFromNow(auth.mandate.expiresAt, state.now);
  let credIdInput = "";
  let cadenceDays: 30 | 60 | 90 | 180 = 60;

  const draw = (): void => {
    mount(
      root,
      el(
        "div.panel",
        null,
        el("h1", null, `Renew the ${trackName} mandate`),
        el(
          "p",
          null,
          `Your current mandate expires ${days >= 0 ? `in ${days} days` : `${-days} days ago`}. Renewing extends your authority for another period of your choice.`,
        ),
        el(
          "label",
          null,
          "Credential id (base64url) — paste from your records or leave blank to discover",
        ),
        el("input", {
          type: "text",
          placeholder: "(saved credential id)",
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
                store.update({
                  route: { kind: "project", repoUrl, view: "health" },
                }),
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
                    credentialId: credIdInput || auth.holder,
                  });
                  if (id.pubKey !== auth.holder) {
                    throw new Error(
                      "the credential you used does not match the holder of the active mandate",
                    );
                  }
                  const mandate = buildRenewalMandate({
                    holderPub: id.pubKey,
                    holderPriv: id.privKey,
                    successors: auth.successors,
                    track: trackName,
                    now: state.now,
                    durationDays: cadenceDays,
                  });
                  const result = await state.adapter.submitEnvelope({
                    repoUrl,
                    path: pathForMandate(trackName, mandate.issuedAt, "renewal"),
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
            state.adapter.canCommit ? "Sign & push" : "Sign & download",
          ),
        ),
      ),
    );
  };

  draw();
}

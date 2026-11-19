# Release 0.5: the work list

Started 2026-11-17 from owner decisions taken during 0.4. Add each item as the owner decides it; the 0.5 journal takes
over once "let's start 0.5" is said.

## Decided for 0.5

1. **The overlay network** (owner, 2026-11-16): key-derived ULA addresses, trusted peers direct and strangers through
   relays, a PQ transport, and one relay mesh. Design: `docs/networking-vision.md`, overlay section.
2. ~~Business / Enterprise plan~~: moved into 0.4 (owner, 2026-11-17: "I meant putting the enterprise features in 0.4").
3. **Cluster backup** (the owner's own servers back each other up, orchestrated by Flagship; a paid feature) and
   **Flagship Vault** (end-to-end encrypted off-site backup space, included in plans plus prepaid blocks). Both are in
   `docs/plans-and-backup-offer.md`.
4. **Community OHTTP relays** (owner, 2026-11-17): volunteers run relays, and a request picks one at random. Registered
   and health-checked, with Sybil limits. The rule from `docs/outbound-proxy.md` "Failure handling" still applies: if
   our infrastructure fails, the system keeps working.

## Carried over from 0.4

- F14, the parked after-launch work: a second relay by DNS round-robin, Rust production qualification (G10), removing
  old implementations once proven (G8), the gym on IPv6 only, `VOICI_CANONICAL`.
- Payments step 6 (the Monero view wallet, after the accountant's advice) and step 7 (paid marketplace apps, 10% cut).
- WireGuard full tunnel for the outbound proxy.
- OHTTP for every box's setup, and the OHTTP client in the initramfs.

## Reassess at the start of 0.5

- **Voucher-file import on iPhone** (owner, 2026-11-18). 0.4 ships it on Android only. iOS 1.3 takes only the "Load
  into Flagship" link, because a visible file import risks App Review guideline 3.1.1 ("license keys") on the first
  in-app purchase review. Once Apple has approved the in-app purchases, decide whether to add the file import to iOS,
  citing 3.1.3(b) in the review notes. If Apple ever objects to the link, check whether it can be switched off
  without a new build (not verified).
- **Bank transfer for Business batches:** a paid `send_invoice` invoice doesn't produce vouchers yet
  (`docs/runbooks/payments-setup.md`).
- **Adapter review: not tied to one provider** (owner, 2026-11-19). `apps/com/src/adapterReview.ts` calls only
  Anthropic's API (`ADAPTER_REVIEW_ANTHROPIC_KEY`). Move it to the OpenAI-compatible upstream Flagship Inference
  already uses (DeepInfra, OpenRouter fallback), with a provider-neutral secret name. Update release.sh's secret list.

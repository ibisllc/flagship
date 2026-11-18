# Strings that need a native reader before a language ships

Added with the "ask the owner before a key-erasing sign-out" change. All six translations are machine drafts.

- "Sign out without recovery?" and the two "You have no cloud recovery set up…" messages: they warn that erasing the key
  is permanent when no recovery exists. Check that the warning reads as irreversible, not as a hint.
  (The lock-screen message reuses Android's `you_have_no_cloud_recovery_set` wording; the update-required one differs only in its last sentence, "Back up your account key first.")
- "Sign out of Flagship" and "Remove this account from the device": the reason line under the Face ID / passcode prompt. Short, imperative, no question mark.
- Escrow errors in FlagshipServerClient.swift:2617-2639 use a new term "escrow" (es/pt-BR "depósito en custodia"/"depósito em custódia", fr "dépôt sous séquestre", de "Treuhandeintrag", ja "エスクロー", zh-Hans "托管"); not in the glossary yet.

Added with the 0.4 "true today" copy (`docs/phone-apps-copy-proposal.md` (a), 2026-11-17). Machine drafts, same wording as
Android's:

- The Welcome line "A personal cloud you actually own. You build and approve everything from your phone; your server
  runs your apps." It must say the phone is where you build and approve, and the server is where apps run; no language
  may read as "apps run on your phone" (store review reads the onboarding too).
- Home's quick action "Build an app" / "Describe it right here. Your server builds and runs it." The title replaces
  "Build a service" on Home only; the build screen's title and the Services tab still say "Build a service" (the
  app/service glossary decision is open, `AGENTS.md` feat/UX item 8). "Here" is this app: es/fr/de use the feminine
  "la"/"sie" for the user's app, pt-BR the masculine "o".

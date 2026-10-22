# Strings that need a native reader before a language ships

Added with the "ask the owner before a key-erasing sign-out" change. All six translations are machine drafts.

- "Sign out without recovery?" and the two "You have no cloud recovery set up…" messages: they warn that erasing the key
  is permanent when no recovery exists. Check that the warning reads as irreversible, not as a hint.
  (The lock-screen message reuses Android's `you_have_no_cloud_recovery_set` wording; the update-required one differs only in its last sentence, "Back up your account key first.")
- "Sign out of Flagship" and "Remove this account from the device": the reason line under the Face ID / passcode prompt. Short, imperative, no question mark.

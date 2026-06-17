// Shared helper for the "this marketplace app needs an LLM key" install path.
//
// When a listing's `requiresLlmKey` is true, the install must NOT dead-end at
// "installed but broken" — after a successful install we deep-link the owner
// straight into the per-app "Configure environment" editor with the expected
// env-var NAME prefilled, so they can paste the key (the value is sealed on
// the box; flagshipserver.com never sees it).
//
// The env-var name comes from the listing (`llmKeyEnvVar`); when the listing
// doesn't carry one we fall back to this default. Kept byte-identical with the
// daemon BFF (`LLM_KEY_ENV_DEFAULT`), iOS (`MarketplaceLlmKey`), and Android
// (`MarketplaceLlmKey`) so the prefilled-name UX is the same everywhere.

export const LLM_KEY_ENV_DEFAULT = "OPENAI_API_KEY";

/**
 * The env-var name to prefill for a listing that needs an LLM key. Returns the
 * listing's declared name, else the shared default.
 */
export function llmKeyEnvVarFor(listing) {
  const name = listing?.llmKeyEnvVar;
  return typeof name === "string" && name.length > 0 ? name : LLM_KEY_ENV_DEFAULT;
}

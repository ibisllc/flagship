// Where Flagship lives. The extension acts only on names under these apexes (manifest host_permissions match).

/** The control apex: identity, the /qr-pipe relay, app links. */
export const CONTROL_APEX = "flagshipserver.com";
/** Box names: `<server>.<account>.flagship.services` and the apps under them. */
export const DATA_APEX = "flagship.services";
/** Direct names an owner gives an app (docs/direct-access-and-domains.md). */
export const DIRECT_APEX = "fshp.app";

/** How old a box's signed fingerprint may be and still count as current (the phones use the same week). */
export const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far ahead of this computer's clock a fresh report may be dated (a box clock a little fast). */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
/** How long the pin check waits for a box's fresh signed fingerprint before deciding. */
export const REFRESH_TIMEOUT_MS = 8000;
/** The box route that serves the signed fingerprint to the extension's session. */
export const CERT_PIN_PATH = "/api/companion/cert-pin";
/** The site permission the pin check and the pairing need (Firefox grants MV3 host permissions only when asked). */
export const SITE_ORIGINS = ["*://*.flagship.services/*", "*://*.fshp.app/*"];

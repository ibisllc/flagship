//! The unlock flow of `installer/boot-stage.sh` and the Debian initramfs
//! premount, step for step:
//!
//! - `auto`: GET the box-sealed lease and open it with the STK; on any miss
//!   (404, 423, other status, transport error, bad body, failed open) fall
//!   back to the relay.
//! - `approve` (or a one-shot lock): relay only, never read a lease.
//! - relay: POST one STK-signed `SecretRequest` (built once, re-sent unchanged
//!   as the heartbeat), poll `GET /api/boot/response/<domain>/<nonce>` with a
//!   fresh box-auth header each time, back off 3, 6, 9, 12, 15 then 15 s,
//!   re-announce every heartbeat interval, stop at the window's end. A 200
//!   with no sealed body, or one that will not open, ends the relay (no
//!   retry), as today.
//!
//! The recovered key is returned in a zeroizing buffer; it is never logged,
//! written to a file, or put in argv or the environment.

use super::policy::Endpoint;
use super::transport::{HttpResponse, Method, Transport};
use crate::canonical;
use crate::gohex;
use crate::identity::BoxIdentity;
use crate::seal;
use core::fmt;
use std::io::Write;
use zeroize::Zeroizing;

/// The purpose the boot path asks for.
pub const PURPOSE_UNLOCK_KEY: &str = "unlock-key";

/// The two-tier policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Lease first, then relay.
    Auto,
    /// Relay every boot; never read a lease.
    Approve,
}

/// How a timed wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    /// The time passed (or a non-`manual` console line cut it short).
    Elapsed,
    /// `manual` was typed on the console (the debug passphrase fallback).
    Manual,
}

/// Time and waiting, injectable for tests.
pub trait Clock {
    /// Wall-clock milliseconds since the epoch (signed into requests).
    fn now_ms(&self) -> u64;
    /// Wall-clock seconds (the relay's deadline and heartbeat arithmetic).
    fn now_secs(&self) -> u64;
    /// Wait `secs`, or less if the console interrupts.
    fn wait(&self, secs: u64) -> Wake;
}

/// Randomness for nonces, injectable for tests.
pub trait Random {
    /// 32 fresh random bytes.
    fn nonce32(&self) -> Result<[u8; 32], String>;
}

/// The OS RNG.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsRandom;

impl Random for OsRandom {
    fn nonce32(&self) -> Result<[u8; 32], String> {
        let mut b = [0u8; 32];
        getrandom::fill(&mut b).map_err(|e| e.to_string())?;
        Ok(b)
    }
}

/// Relay timing: the shell's `FLAGSHIP_RELAY_WINDOW_SECS` (default about a
/// year) and `FLAGSHIP_RELAY_HEARTBEAT_SECS` (default 120).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayTiming {
    /// Give up after this many seconds without a reply.
    pub window_secs: u64,
    /// Re-announce the parked request this often.
    pub heartbeat_secs: u64,
}

impl Default for RelayTiming {
    fn default() -> Self {
        Self {
            window_secs: 31_536_000,
            heartbeat_secs: 120,
        }
    }
}

/// Why the box could not get its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnlockError {
    /// A request field could not be signed unambiguously.
    Field(String),
    /// No randomness.
    Random(String),
    /// The first announce was refused or failed.
    Announce(String),
    /// The reply had no sealed payload.
    NoSealedPayload,
    /// The reply did not open under this box's STK and request.
    Unseal(seal::SealError),
    /// `manual` was typed on the console.
    ManualSelected,
    /// The relay window ended with no reply.
    WindowElapsed(u64),
}

impl fmt::Display for UnlockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Field(e) => write!(f, "cannot sign the request: {e}"),
            Self::Random(e) => write!(f, "no randomness for the nonce: {e}"),
            Self::Announce(e) => write!(f, "relay boot-request {e}"),
            Self::NoSealedPayload => f.write_str("relay 200 but no sealed payload"),
            Self::Unseal(e) => write!(f, "could not open the phone's reply: {e}"),
            Self::ManualSelected => f.write_str("manual unlock selected"),
            Self::WindowElapsed(s) => write!(
                f,
                "relay backstop window ({s}s) elapsed with no phone reply"
            ),
        }
    }
}

impl std::error::Error for UnlockError {}

/// Everything one boot's unlock needs.
pub struct Unlocker<'a> {
    /// The box FQDN (`/boot/server-domain`).
    pub server_domain: &'a str,
    /// The STK.
    pub identity: &'a BoxIdentity,
    /// The approved worker origin.
    pub endpoint: &'a Endpoint,
    /// HTTP.
    pub transport: &'a dyn Transport,
    /// Time.
    pub clock: &'a dyn Clock,
    /// Nonces.
    pub random: &'a dyn Random,
    /// Relay timing.
    pub timing: RelayTiming,
    /// Mentioned in the wait lines when the console fallback is on.
    pub console_hint: bool,
    /// Progress lines (stderr in the binary). Never receives secrets.
    pub log: &'a mut dyn Write,
}

impl fmt::Debug for Unlocker<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Unlocker")
            .field("server_domain", &self.server_domain)
            .field("endpoint", &self.endpoint)
            .field("timing", &self.timing)
            .finish_non_exhaustive()
    }
}

/// First 200 bytes of a body, printable only, for the shell's `head -c 200`.
fn snippet(body: &[u8]) -> String {
    body.iter()
        .take(200)
        .map(|&b| {
            if b.is_ascii_graphic() || b == b' ' {
                char::from(b)
            } else {
                '.'
            }
        })
        .collect()
}

/// A hex string field of a JSON body (the shell's `sed` on `"field":"<hex>"`).
fn hex_field(body: &[u8], field: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let s = v.get(field)?.as_str()?;
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())).then(|| s.to_owned())
}

impl Unlocker<'_> {
    fn line(&mut self, msg: &str) {
        let _ = writeln!(self.log, "flagship: {msg}");
    }

    fn fresh_nonce_hex(&self) -> Result<String, UnlockError> {
        self.random
            .nonce32()
            .map(|n| gohex::encode(&n))
            .map_err(UnlockError::Random)
    }

    fn signed(
        &self,
        method: Method,
        path: &str,
        body: Option<&str>,
    ) -> Result<Result<HttpResponse, String>, UnlockError> {
        let nonce = self.fresh_nonce_hex()?;
        let auth = canonical::box_auth_header(
            self.identity,
            self.server_domain,
            method.as_str(),
            path,
            &nonce,
            self.clock.now_ms(),
        )
        .map_err(|e| UnlockError::Field(e.to_string()))?;
        Ok(self
            .transport
            .send(method, &self.endpoint.url(path), &auth, body))
    }

    /// Run the dispatch for `mode` and return the LUKS key bytes.
    pub fn unlock(&mut self, mode: Mode) -> Result<Zeroizing<Vec<u8>>, UnlockError> {
        if mode == Mode::Auto
            && let Some(key) = self.via_lease()?
        {
            return Ok(key);
        }
        self.via_relay()
    }

    /// `unlock_via_box_lease`: `Ok(None)` means "fall back to the relay".
    pub fn via_lease(&mut self) -> Result<Option<Zeroizing<Vec<u8>>>, UnlockError> {
        let path = format!("/api/boot/lease/{}", self.server_domain);
        let resp = match self.signed(Method::Get, &path, None)? {
            Ok(r) => r,
            Err(e) => {
                self.line(&format!("box-lease HTTP 000 ({e})"));
                return Ok(None);
            }
        };
        match resp.status {
            200 => {}
            404 => {
                self.line("no box-sealed lease (HTTP 404) — falling back");
                return Ok(None);
            }
            423 => {
                self.line(
                    "this server is locked at the boot service (HTTP 423) — asking the phone",
                );
                return Ok(None);
            }
            s => {
                self.line(&format!(
                    "box-lease HTTP {s}; body: {}",
                    snippet(&resp.body)
                ));
                return Ok(None);
            }
        }
        let Some(sealed_hex) = hex_field(&resp.body, "sealedKey") else {
            self.line(&format!(
                "box-lease 200 but no sealedKey: {}",
                snippet(&resp.body)
            ));
            return Ok(None);
        };
        let seed = self.identity.seed();
        let opened = gohex::decode(sealed_hex.as_bytes())
            .map_err(|_| seal::SealError::BlobTooShort)
            .and_then(|sealed| seal::open_sealed_from_ed25519_seed(&sealed, seed.as_slice()));
        match opened {
            Ok(key) => {
                self.line("self-unlocked from the box-sealed lease");
                Ok(Some(key))
            }
            Err(e) => {
                self.line(&format!("unseal failed on box-lease: {e}"));
                Ok(None)
            }
        }
    }

    /// `unlock_via_relay`.
    pub fn via_relay(&mut self) -> Result<Zeroizing<Vec<u8>>, UnlockError> {
        let nonce = self.fresh_nonce_hex()?;
        let issued_at = self.clock.now_ms();
        let body = canonical::secret_request_body(
            self.identity,
            self.server_domain,
            PURPOSE_UNLOCK_KEY,
            &nonce,
            issued_at,
        )
        .map_err(|e| UnlockError::Field(e.to_string()))?;
        let req_path = "/api/boot/request";
        let hint = if self.console_hint {
            " (type 'manual' then Enter to unlock by passphrase)"
        } else {
            ""
        };

        match self.signed(Method::Post, req_path, Some(&body))? {
            Ok(r) if r.status == 200 => {}
            Ok(r) => {
                let msg = format!("HTTP {}; body: {}", r.status, snippet(&r.body));
                self.line(&format!("relay boot-request {msg}"));
                return Err(UnlockError::Announce(msg));
            }
            Err(e) => {
                let msg = format!("HTTP 000 ({e})");
                self.line(&format!("relay boot-request {msg}"));
                return Err(UnlockError::Announce(msg));
            }
        }
        self.line(&format!(
            "posted unlock-key boot-request; waiting for phone approval{hint}"
        ));

        let poll_path = format!("/api/boot/response/{}/{nonce}", self.server_domain);
        let deadline = self
            .clock
            .now_secs()
            .saturating_add(self.timing.window_secs);
        let mut last_announce = self.clock.now_secs();
        let mut attempt: u64 = 0;
        while self.clock.now_secs() < deadline {
            attempt = attempt.saturating_add(1);
            match self.signed(Method::Get, &poll_path, None)? {
                Ok(r) if r.status == 200 => {
                    let Some(sealed_hex) = hex_field(&r.body, "sealed") else {
                        self.line(&format!(
                            "relay 200 but no sealed payload: {}",
                            snippet(&r.body)
                        ));
                        return Err(UnlockError::NoSealedPayload);
                    };
                    let seed = self.identity.seed();
                    let opened = gohex::decode(sealed_hex.as_bytes())
                        .map_err(|_| seal::SealError::BlobTooShort)
                        .and_then(|sealed| {
                            seal::open_sealed_secret_response(
                                &sealed,
                                seed.as_slice(),
                                &nonce,
                                PURPOSE_UNLOCK_KEY,
                            )
                        });
                    return match opened {
                        Ok(key) => {
                            self.line(&format!(
                                "relay unsealed the unlock key (attempt {attempt})"
                            ));
                            Ok(key)
                        }
                        Err(e) => {
                            self.line(&format!("unseal failed: {e}"));
                            Err(UnlockError::Unseal(e))
                        }
                    };
                }
                Ok(r) if r.status == 404 => {}
                Ok(r) => self.line(&format!(
                    "relay boot-response HTTP {}; body: {}",
                    r.status,
                    snippet(&r.body)
                )),
                Err(e) => self.line(&format!("relay boot-response HTTP 000 ({e})")),
            }

            if self.clock.now_secs().saturating_sub(last_announce) >= self.timing.heartbeat_secs {
                match self.signed(Method::Post, req_path, Some(&body))? {
                    Ok(r) if r.status == 200 => {
                        self.line("heartbeat re-announced boot-request (TTL refreshed)")
                    }
                    Ok(r) => self.line(&format!(
                        "heartbeat re-announce failed (HTTP {}); continuing",
                        r.status
                    )),
                    Err(e) => self.line(&format!(
                        "heartbeat re-announce failed (HTTP 000: {e}); continuing"
                    )),
                }
                last_announce = self.clock.now_secs();
            }

            let backoff = if attempt < 6 {
                attempt.saturating_mul(3)
            } else {
                15
            };
            self.line(&format!(
                "no phone reply yet (attempt {attempt}); waiting {backoff}{hint}"
            ));
            if self.clock.wait(backoff) == Wake::Manual {
                self.line("manual unlock selected — falling through to the disk passphrase prompt");
                return Err(UnlockError::ManualSelected);
            }
        }
        let e = UnlockError::WindowElapsed(self.timing.window_secs);
        self.line(&e.to_string());
        Err(e)
    }
}

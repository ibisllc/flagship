//! The unlock flow of the Debian initramfs premount
//! (packages/boot-chain/src/unlockPremount.ts), step for step:
//!
//! - `auto`: with the owner's key on /boot, GET the auto-unlock lease, check
//!   it (owner signature, this server, this box's boot key, expiry; the Go
//!   helper's `--lease-json` rules) and open it with the boot key. No owner
//!   key, any status but 200, or a refused lease: ask the phone.
//! - `approve` (or a one-shot lock): relay only, never read a lease.
//! - relay: POST a boot-key-signed `SecretRequest`, poll
//!   `GET /api/boot/response/<domain>/<nonce>` with a fresh box-auth header
//!   each time, back off 3, 6, 9, 12, 15 then 15 s, re-announce the same
//!   request every heartbeat. A request lives at most
//!   `request_lifetime_secs`; then (or when a reply does not open, or the
//!   announce is refused, after 30 s) a fresh request with a new nonce and
//!   `issuedAt` is signed. The whole wait ends after `window_secs` with
//!   [`UnlockError::WindowElapsed`], for which the caller restarts the box.
//!
//! The recovered key is returned in a zeroizing buffer; it is never logged,
//! written to a file, or put in argv or the environment.

use super::policy::Endpoint;
use super::transport::{HttpResponse, Method, Transport};
use crate::canonical;
use crate::gohex;
use crate::identity::BoxIdentity;
use crate::seal;
use crate::v2::{self, UnlockPolicy};
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

/// The premount's longest wait for the phone (and the default).
pub const RELAY_MAX_SECS: u64 = 604_800;
/// The premount's longest life of one signed request (and the default).
pub const REQUEST_LIFETIME_MAX_SECS: u64 = 21_600;
/// How long to wait after a refused announce before asking again.
pub const REFUSED_RETRY_SECS: u64 = 30;

/// Relay timing: `FLAGSHIP_RELAY_WINDOW_SECS`, `FLAGSHIP_RELAY_HEARTBEAT_SECS`
/// and `FLAGSHIP_RELAY_REQUEST_SECS` in the premount.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayTiming {
    /// Give up (and let the caller restart) after this many seconds.
    pub window_secs: u64,
    /// Re-announce the parked request this often.
    pub heartbeat_secs: u64,
    /// Sign a fresh request at least this often.
    pub request_lifetime_secs: u64,
}

impl Default for RelayTiming {
    fn default() -> Self {
        Self {
            window_secs: RELAY_MAX_SECS,
            heartbeat_secs: 120,
            request_lifetime_secs: REQUEST_LIFETIME_MAX_SECS,
        }
    }
}

impl RelayTiming {
    /// The premount's bounds: window 1..604800, heartbeat 10..600, request
    /// lifetime 2..21600.
    pub fn clamped(self) -> Self {
        Self {
            window_secs: self.window_secs.clamp(1, RELAY_MAX_SECS),
            heartbeat_secs: self.heartbeat_secs.clamp(10, 600),
            request_lifetime_secs: self
                .request_lifetime_secs
                .clamp(2, REQUEST_LIFETIME_MAX_SECS),
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
            Self::ManualSelected => f.write_str("manual unlock selected"),
            Self::WindowElapsed(s) => write!(f, "no phone reply within {s}s"),
        }
    }
}

impl std::error::Error for UnlockError {}

/// The boot key's v2 material on /boot (pq-suites.md §19).
pub struct PqBoot {
    /// The boot key's ML-DSA-65 seed (`flagship-boot-mldsa.key`): signs v2 requests.
    pub mldsa_seed: Zeroizing<[u8; 32]>,
    /// The owner's hybrid key (`flagship-owner-pq.pub`) v2 replies and v3 leases are signed by.
    pub owner_pq: Option<Vec<u8>>,
    /// The lease key's seed (from the TPM, or `flagship-lease-kem.key`); `None` skips v3 leases.
    pub lease_seed: Option<Zeroizing<[u8; 32]>>,
}

impl fmt::Debug for PqBoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PqBoot")
            .field("owner_pq", &self.owner_pq.is_some())
            .field("lease_seed", &self.lease_seed.is_some())
            .finish_non_exhaustive()
    }
}

/// Everything one boot's unlock needs.
pub struct Unlocker<'a> {
    /// The box FQDN (`/boot/server-domain`).
    pub server_domain: &'a str,
    /// The boot key (`/boot/flagship-boot-key.pem`): signs and opens.
    pub identity: &'a BoxIdentity,
    /// The owner key a lease must be signed by; `None` skips the lease.
    pub owner_pub: Option<[u8; 32]>,
    /// The approved worker origin.
    pub endpoint: &'a Endpoint,
    /// HTTP.
    pub transport: &'a dyn Transport,
    /// Time.
    pub clock: &'a dyn Clock,
    /// Nonces.
    pub random: &'a dyn Random,
    /// Relay timing (clamped to the premount's bounds when used).
    pub timing: RelayTiming,
    /// Mentioned in the wait lines when the console fallback is on.
    pub console_hint: bool,
    /// Progress lines (stderr in the binary). Never receives secrets.
    pub log: &'a mut dyn Write,
    /// v2 material; `None` keeps the v1 flow.
    pub pq: Option<&'a PqBoot>,
    /// Strict refuses every classical reply and lease.
    pub policy: UnlockPolicy,
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

    /// `unlock_via_box_lease`: `Ok(None)` means "ask the phone".
    pub fn via_lease(&mut self) -> Result<Option<Zeroizing<Vec<u8>>>, UnlockError> {
        let Some(owner) = self.owner_pub else {
            self.line("no owner key on /boot; asking the phone");
            return Ok(None);
        };
        let path = format!("/api/boot/lease/{}", self.server_domain);
        let resp = match self.signed(Method::Get, &path, None)? {
            Ok(r) => r,
            Err(e) => {
                self.line(&format!(
                    "no usable lease (HTTP 000: {e}); asking the phone"
                ));
                return Ok(None);
            }
        };
        match resp.status {
            200 => {}
            423 => {
                self.line("this server is locked at the boot service (HTTP 423); asking the phone");
                return Ok(None);
            }
            s => {
                self.line(&format!(
                    "no usable lease (HTTP {s}): {}; asking the phone",
                    snippet(&resp.body)
                ));
                return Ok(None);
            }
        }
        let seed = self.identity.seed();
        let now = i64::try_from(self.clock.now_ms()).unwrap_or(i64::MAX);
        match v2::open_auto_unlock_lease_any(
            &resp.body,
            &seed,
            self.server_domain.as_bytes(),
            &owner,
            self.pq.and_then(|p| p.owner_pq.as_deref()),
            self.pq.and_then(|p| p.lease_seed.as_deref()),
            self.policy,
            now,
        ) {
            Ok(key) => {
                self.line("unlocked from the auto-unlock lease");
                Ok(Some(key))
            }
            Err(e) => {
                self.line(&format!("lease refused: {e}"));
                Ok(None)
            }
        }
    }

    fn wait(&mut self, secs: u64) -> Result<(), UnlockError> {
        if self.clock.wait(secs) == Wake::Manual {
            self.line("manual unlock selected (debug burn)");
            return Err(UnlockError::ManualSelected);
        }
        Ok(())
    }

    /// `unlock_via_relay`.
    pub fn via_relay(&mut self) -> Result<Zeroizing<Vec<u8>>, UnlockError> {
        let timing = self.timing.clamped();
        let req_path = "/api/boot/request";
        let hint = if self.console_hint {
            " (type 'manual' then Enter to unlock by passphrase)"
        } else {
            ""
        };
        let deadline = self.clock.now_secs().saturating_add(timing.window_secs);
        let mut requests: u64 = 0;
        while self.clock.now_secs() < deadline {
            requests = requests.saturating_add(1);
            let nonce = self.fresh_nonce_hex()?;
            let reply_seed = match self.pq {
                Some(_) => Some(Zeroizing::new(
                    self.random.nonce32().map_err(UnlockError::Random)?,
                )),
                None => None,
            };
            let body = match (self.pq, &reply_seed) {
                (Some(pq), Some(rs)) => v2::sign_request_v2(
                    &self.identity.seed(),
                    &pq.mldsa_seed,
                    self.server_domain,
                    &nonce,
                    i64::try_from(self.clock.now_ms()).unwrap_or(i64::MAX),
                    rs,
                    false,
                )
                .map_err(|e| UnlockError::Field(e.to_string()))?,
                _ => canonical::secret_request_body(
                    self.identity,
                    self.server_domain,
                    PURPOSE_UNLOCK_KEY,
                    &nonce,
                    self.clock.now_ms(),
                )
                .map_err(|e| UnlockError::Field(e.to_string()))?,
            };
            let request_end = self
                .clock
                .now_secs()
                .saturating_add(timing.request_lifetime_secs)
                .min(deadline);
            if let Some(refusal) = self.announce(req_path, &body)? {
                self.line(&format!("unlock request refused ({refusal})"));
                let left = deadline.saturating_sub(self.clock.now_secs());
                self.wait(REFUSED_RETRY_SECS.min(left).max(1))?;
                continue;
            }
            self.line(&format!(
                "asked the phone to approve (request {requests}){hint}"
            ));

            let poll_path = format!("/api/boot/response/{}/{nonce}", self.server_domain);
            let mut last_announce = self.clock.now_secs();
            let mut attempt: u64 = 0;
            while self.clock.now_secs() < request_end {
                attempt = attempt.saturating_add(1);
                match self.signed(Method::Get, &poll_path, None)? {
                    Ok(r) if r.status == 200 => {
                        let seed = self.identity.seed();
                        let opened = match hex_field(&r.body, "sealed") {
                            None => Err("no sealed payload".to_owned()),
                            Some(h) => gohex::decode(h.as_bytes())
                                .map_err(|_| "the sealed payload is not hex".to_owned())
                                .and_then(|sealed| {
                                    self.open_reply(&sealed, &seed, &nonce, reply_seed.as_deref())
                                }),
                        };
                        match opened {
                            Ok(key) => {
                                self.line(&format!(
                                    "unlocked with the phone's reply (attempt {attempt})"
                                ));
                                return Ok(key);
                            }
                            Err(e) => {
                                self.line(&format!(
                                    "the reply did not open the disk: {e}; asking again"
                                ));
                                break;
                            }
                        }
                    }
                    Ok(r) if r.status == 404 => {}
                    Ok(r) => self.line(&format!(
                        "reply poll HTTP {}: {}",
                        r.status,
                        snippet(&r.body)
                    )),
                    Err(e) => self.line(&format!("reply poll HTTP 000 ({e})")),
                }

                if self.clock.now_secs().saturating_sub(last_announce) >= timing.heartbeat_secs {
                    match self.announce(req_path, &body)? {
                        None => self.line("heartbeat re-announced boot-request (TTL refreshed)"),
                        Some(r) => self.line(&format!("heartbeat re-announce failed ({r})")),
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
                self.wait(backoff)?;
            }
        }
        let e = UnlockError::WindowElapsed(timing.window_secs);
        self.line(&e.to_string());
        Err(e)
    }

    fn open_reply(
        &self,
        sealed: &[u8],
        seed: &[u8; 32],
        nonce: &str,
        reply_seed: Option<&[u8; 32]>,
    ) -> Result<Zeroizing<Vec<u8>>, String> {
        v2::box_accepts(self.policy, sealed).map_err(|e| e.to_string())?;
        if !v2::is_v2_sealed(sealed) {
            return seal::open_sealed_secret_response(
                sealed,
                seed.as_slice(),
                nonce,
                PURPOSE_UNLOCK_KEY,
            )
            .map_err(|e| e.to_string());
        }
        let (Some(pq), Some(rs)) = (self.pq, reply_seed) else {
            return Err("a v2 reply but no v2 material on /boot".into());
        };
        let owner = pq
            .owner_pq
            .as_deref()
            .ok_or("a v2 reply but no owner hybrid key on /boot")?;
        let boot = self.identity.pub_hex().to_owned();
        v2::open_boot_reply_v2(sealed, self.server_domain, &boot, nonce, rs, owner)
            .map_err(|e| e.to_string())
    }

    /// POST the signed request; `Some(why)` when it was not accepted.
    fn announce(&mut self, path: &str, body: &str) -> Result<Option<String>, UnlockError> {
        Ok(match self.signed(Method::Post, path, Some(body))? {
            Ok(r) if r.status == 200 => None,
            Ok(r) => Some(format!("HTTP {}: {}", r.status, snippet(&r.body))),
            Err(e) => Some(format!("HTTP 000: {e}")),
        })
    }
}

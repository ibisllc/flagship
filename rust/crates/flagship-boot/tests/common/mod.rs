//! Test doubles: an in-process boot worker that applies the gate's rules
//! (signature, binding, ±5 min freshness, single-use nonce) and the routes'
//! behaviour, a fake clock, and fixed randomness.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic,
    missing_debug_implementations
)]

use flagship_boot::canonical::{self, RequestRefusal};
use flagship_boot::gohex;
use flagship_boot::seal;
use flagship_boot::unlock::flow::{Clock, Random, Wake};
use flagship_boot::unlock::transport::{HttpResponse, Method, Transport};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

pub const DOMAIN: &str = "home.alice.flagship.services";
pub const SEED_A: [u8; 32] = [0x0b; 32];
pub const SEED_B: [u8; 32] = [0x0c; 32];
pub const T0: u64 = 1_760_000_000_000;

pub fn luks_key() -> Vec<u8> {
    (0..64u32).map(|i| (i * 13 + 7) as u8).collect()
}

pub fn xpub(seed: &[u8; 32]) -> [u8; 32] {
    seal::x25519_public_from_ed25519_seed(seed).unwrap()
}

/// Seals a reply for a request nonce.
pub type BuildReply = Rc<dyn Fn(&str) -> Vec<u8>>;

/// How the worker answers response polls.
#[derive(Clone)]
pub enum Reply {
    /// Never (404 forever).
    Never,
    /// After `after` 404s, a reply sealed by `build(request_nonce_hex)`.
    After { after: u32, build: BuildReply },
    /// After `after` 404s, a 200 with no sealed payload.
    Empty { after: u32 },
}

pub struct Worker {
    pub now: Rc<Cell<u64>>,
    pub stk_hex: String,
    pub lease: Option<Vec<u8>>,
    pub suspended: bool,
    pub post_status: u16,
    pub reply: Reply,
    pub seen: HashSet<String>,
    pub calls: Vec<(Method, String)>,
    pub bodies: Vec<String>,
    pub request_nonce: Option<String>,
    pub polls: u32,
    pub refusals: Vec<String>,
    pub fail_transport_on_poll: Vec<u32>,
}

impl Worker {
    pub fn new(now: Rc<Cell<u64>>) -> Self {
        Self {
            now,
            stk_hex: flagship_boot::identity::BoxIdentity::from_seed(&SEED_A)
                .pub_hex()
                .to_owned(),
            lease: None,
            suspended: false,
            post_status: 200,
            reply: Reply::Never,
            seen: HashSet::new(),
            calls: Vec::new(),
            bodies: Vec::new(),
            request_nonce: None,
            polls: 0,
            refusals: Vec::new(),
            fail_transport_on_poll: Vec::new(),
        }
    }

    fn deny(&mut self, status: u16, why: &str) -> HttpResponse {
        self.refusals.push(why.to_owned());
        HttpResponse {
            status,
            body: format!("{{\"error\":\"{why}\"}}").into_bytes(),
        }
    }

    pub fn handle(
        &mut self,
        method: Method,
        url: &str,
        auth: &str,
        body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        let path = url
            .split_once("://")
            .map(|(_, r)| &r[r.find('/').unwrap()..])
            .unwrap()
            .to_owned();
        self.calls.push((method, path.clone()));
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let domain = match parts.as_slice() {
            ["api", "boot", "lease", d] => (*d).to_owned(),
            ["api", "boot", "response", d, _] => (*d).to_owned(),
            ["api", "boot", "request"] => {
                let v: serde_json::Value = serde_json::from_str(body.unwrap_or("{}")).unwrap();
                v["request"]["serverDomain"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            }
            _ => {
                return Ok(HttpResponse {
                    status: 404,
                    body: b"{\"error\":\"not found\"}".to_vec(),
                });
            }
        };
        let stk = self.stk_hex.clone();
        match canonical::verify_box_auth(
            auth,
            &stk,
            &domain,
            method.as_str(),
            &path,
            self.now.get(),
        ) {
            Ok(env) => {
                if !self.seen.insert(env.nonce_hex.clone()) {
                    return Ok(self.deny(403, "replayed nonce"));
                }
            }
            Err(RequestRefusal::Stale) => return Ok(self.deny(403, "stale request")),
            Err(RequestRefusal::WrongKey) => {
                return Ok(self.deny(403, "box STK not bound to this server"));
            }
            Err(e) => return Ok(self.deny(403, &format!("{e:?}"))),
        }
        match parts.as_slice() {
            ["api", "boot", "lease", _] => {
                if self.suspended {
                    return Ok(HttpResponse {
                        status: 423,
                        body: b"{\"error\":\"suspended\",\"suspended\":true}".to_vec(),
                    });
                }
                Ok(match &self.lease {
                    Some(l) => HttpResponse {
                        status: 200,
                        body: format!(
                            "{{\"serverDomain\":\"{domain}\",\"leaseId\":\"0123456789abcdef\",\"stkPub\":\"{stk}\",\"sealedKey\":\"{}\",\"issuedAt\":1,\"expiresAt\":2,\"maxUses\":null,\"usesConsumed\":0,\"signature\":\"{}\"}}",
                            gohex::encode(l),
                            "00".repeat(64)
                        )
                        .into_bytes(),
                    },
                    None => HttpResponse { status: 404, body: b"{\"error\":\"no active lease\"}".to_vec() },
                })
            }
            ["api", "boot", "request"] => {
                let b = body.unwrap_or_default();
                let v: serde_json::Value = serde_json::from_str(b).unwrap();
                let r = &v["request"];
                let ok = canonical::verify_secret_request(
                    r["serverDomain"].as_str().unwrap(),
                    r["stkPub"].as_str().unwrap(),
                    r["purpose"].as_str().unwrap(),
                    r["nonce"].as_str().unwrap(),
                    r["issuedAt"].as_u64().unwrap(),
                    v["signature"].as_str().unwrap(),
                );
                if !ok || r["stkPub"].as_str() != Some(stk.as_str()) {
                    return Ok(self.deny(403, "invalid request signature"));
                }
                self.bodies.push(b.to_owned());
                self.request_nonce = Some(r["nonce"].as_str().unwrap().to_owned());
                Ok(HttpResponse {
                    status: self.post_status,
                    body: b"{\"ok\":true}".to_vec(),
                })
            }
            ["api", "boot", "response", _, nonce] => {
                self.polls += 1;
                if self.fail_transport_on_poll.contains(&self.polls) {
                    return Err("connection reset".into());
                }
                let nonce = (*nonce).to_owned();
                let none = HttpResponse {
                    status: 404,
                    body: b"{\"error\":\"no reply ready\"}".to_vec(),
                };
                match self.reply.clone() {
                    Reply::Never => Ok(none),
                    Reply::Empty { after } if self.polls > after => Ok(HttpResponse {
                        status: 200,
                        body: b"{\"serverDomain\":\"x\",\"sealed\":\"\"}".to_vec(),
                    }),
                    Reply::After { after, build } if self.polls > after => {
                        self.reply = Reply::Never;
                        Ok(HttpResponse {
                            status: 200,
                            body: format!(
                                "{{\"serverDomain\":\"{domain}\",\"requestNonceHex\":\"{nonce}\",\"purpose\":\"unlock-key\",\"sealed\":\"{}\",\"issuedAt\":5}}",
                                gohex::encode(&build(&nonce))
                            )
                            .into_bytes(),
                        })
                    }
                    _ => Ok(none),
                }
            }
            _ => unreachable!(),
        }
    }
}

pub struct MockTransport(pub RefCell<Worker>);

impl Transport for MockTransport {
    fn send(
        &self,
        method: Method,
        url: &str,
        authorization: &str,
        json_body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        self.0
            .borrow_mut()
            .handle(method, url, authorization, json_body)
    }
}

pub struct FakeClock {
    pub now: Rc<Cell<u64>>,
    pub waits: RefCell<Vec<u64>>,
    pub manual_on_wait: Option<usize>,
}

impl FakeClock {
    pub fn new(now: Rc<Cell<u64>>) -> Self {
        Self {
            now,
            waits: RefCell::new(Vec::new()),
            manual_on_wait: None,
        }
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }
    fn now_secs(&self) -> u64 {
        self.now.get() / 1000
    }
    fn wait(&self, secs: u64) -> Wake {
        self.waits.borrow_mut().push(secs);
        if self.manual_on_wait == Some(self.waits.borrow().len()) {
            return Wake::Manual;
        }
        self.now.set(self.now.get() + secs * 1000);
        Wake::Elapsed
    }
}

/// Distinct nonces 1, 2, 3, ... (fixed so runs are reproducible).
pub struct CountingRandom(pub Cell<u8>);

impl Random for CountingRandom {
    fn nonce32(&self) -> Result<[u8; 32], String> {
        self.0.set(self.0.get().wrapping_add(1));
        Ok([self.0.get(); 32])
    }
}

//! The unlock flow against an in-process worker: the owner-checked lease,
//! relay, heartbeat, backoff, fresh requests, and the refusals (replayed
//! reply, wrong server, refused announce, window end, console fallback).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

mod common;

use common::*;
use flagship_boot::identity::BoxIdentity;
use flagship_boot::seal;
use flagship_boot::unlock::flow::{Mode, RelayTiming, UnlockError, Unlocker};
use flagship_boot::unlock::policy::EndpointPolicy;
use flagship_boot::unlock::transport::Method;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

struct Run {
    worker: MockTransport,
    clock: FakeClock,
    log: Vec<u8>,
    owner: Option<[u8; 32]>,
}

impl Run {
    fn new(setup: impl FnOnce(&mut Worker)) -> Self {
        let now = Rc::new(Cell::new(T0));
        let mut w = Worker::new(now.clone());
        setup(&mut w);
        Self {
            worker: MockTransport(RefCell::new(w)),
            clock: FakeClock::new(now),
            log: Vec::new(),
            owner: Some(owner_pub()),
        }
    }

    fn unlock(&mut self, mode: Mode, timing: RelayTiming) -> Result<Vec<u8>, UnlockError> {
        let id = BoxIdentity::from_seed(&SEED_A);
        let endpoint = EndpointPolicy::default()
            .resolve("https://boot.flagshipserver.com")
            .unwrap();
        let random = CountingRandom(Cell::new(0));
        let mut u = Unlocker {
            server_domain: DOMAIN,
            identity: &id,
            owner_pub: self.owner,
            endpoint: &endpoint,
            transport: &self.worker,
            clock: &self.clock,
            random: &random,
            timing,
            console_hint: false,
            log: &mut self.log,
        };
        u.unlock(mode).map(|k| k.to_vec())
    }

    fn calls(&self) -> Vec<(Method, String)> {
        self.worker.0.borrow().calls.clone()
    }

    fn log(&self) -> String {
        String::from_utf8_lossy(&self.log).into_owned()
    }
}

fn reply_for(seed: [u8; 32], purpose: &'static str, nonce_override: Option<&'static str>) -> Reply {
    Reply::After {
        after: 2,
        build: Rc::new(move |nonce: &str| {
            seal::build_sealed_secret_response_with(
                &luks_key(),
                &xpub(&seed),
                nonce_override.unwrap_or(nonce),
                purpose,
                [9; 32],
                [8; 12],
            )
        }),
    }
}

const QUICK: RelayTiming = RelayTiming {
    window_secs: 600,
    heartbeat_secs: 120,
    request_lifetime_secs: 21_600,
};
const LEASE_PATH: &str = "/api/boot/lease/home.alice.flagship.services";

#[test]
fn auto_opens_the_lease_without_asking_the_phone() {
    let mut r = Run::new(|w| {
        w.lease = Some(seal::seal_for_recipient_with(
            &luks_key(),
            &xpub(&SEED_A),
            [1; 32],
            [2; 12],
        ))
    });
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert_eq!(r.calls(), vec![(Method::Get, LEASE_PATH.to_owned())]);
    assert!(r.log().contains("unlocked from the auto-unlock lease"));
    assert!(
        !r.log().contains(
            &common::luks_key()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    );
}

#[test]
fn auto_falls_back_to_the_relay_on_404_and_423() {
    for suspended in [false, true] {
        let mut r = Run::new(|w| {
            w.suspended = suspended;
            w.lease = suspended.then(|| vec![0; 80]);
            w.reply = reply_for(SEED_A, "unlock-key", None);
        });
        assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
        let calls = r.calls();
        assert_eq!(calls[0], (Method::Get, LEASE_PATH.to_owned()));
        assert_eq!(calls[1], (Method::Post, "/api/boot/request".to_owned()));
        assert_eq!(calls.len(), 2 + 3);
        assert!(
            r.log()
                .contains(if suspended { "HTTP 423" } else { "HTTP 404" })
        );
    }
}

#[test]
fn a_lease_for_another_box_falls_back_to_the_relay() {
    let mut r = Run::new(|w| {
        w.lease = Some(seal::seal_for_recipient_with(
            &luks_key(),
            &xpub(&SEED_B),
            [1; 32],
            [2; 12],
        ));
        w.reply = reply_for(SEED_A, "unlock-key", None);
    });
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert!(r.log().contains("lease refused: gcm open"), "{}", r.log());
}

fn own_lease(w: &mut Worker) {
    w.lease = Some(seal::seal_for_recipient_with(
        &luks_key(),
        &xpub(&SEED_A),
        [1; 32],
        [2; 12],
    ));
    w.reply = reply_for(SEED_A, "unlock-key", None);
}

#[test]
fn a_lease_the_owner_did_not_sign_is_refused() {
    let mut r = Run::new(|w| {
        own_lease(w);
        w.lease_signer = SEED_B;
    });
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert!(
        r.log()
            .contains("lease refused: lease signature does not verify under the owner key")
    );
    assert_eq!(r.calls()[1], (Method::Post, "/api/boot/request".to_owned()));
}

#[test]
fn an_expired_lease_is_refused_by_the_box_clock() {
    let mut r = Run::new(|w| {
        own_lease(w);
        w.lease_expires = T0;
    });
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert!(r.log().contains("lease refused: lease has expired"));
}

#[test]
fn a_lease_naming_another_key_is_refused() {
    let mut r = Run::new(|w| {
        own_lease(w);
        w.lease_stk_hex = Some(BoxIdentity::from_seed(&SEED_B).pub_hex().to_owned());
    });
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert!(
        r.log()
            .contains("lease refused: lease is not sealed to this box's boot key")
    );
}

#[test]
fn without_an_owner_key_the_lease_is_never_read() {
    let mut r = Run::new(own_lease);
    r.owner = None;
    assert_eq!(r.unlock(Mode::Auto, QUICK).unwrap(), luks_key());
    assert!(r.log().contains("no owner key on /boot; asking the phone"));
    assert!(
        r.calls()
            .iter()
            .all(|(_, p)| !p.starts_with("/api/boot/lease"))
    );
}

#[test]
fn approve_never_reads_a_lease() {
    let mut r = Run::new(|w| {
        w.lease = Some(seal::seal_for_recipient_with(
            &luks_key(),
            &xpub(&SEED_A),
            [1; 32],
            [2; 12],
        ));
        w.reply = reply_for(SEED_A, "unlock-key", None);
    });
    assert_eq!(r.unlock(Mode::Approve, QUICK).unwrap(), luks_key());
    assert!(
        r.calls()
            .iter()
            .all(|(_, p)| !p.starts_with("/api/boot/lease"))
    );
}

#[test]
fn relay_backs_off_and_heartbeats_with_the_same_signed_request() {
    let mut r = Run::new(|w| {
        w.reply = Reply::After {
            after: 12,
            build: Rc::new(|n: &str| {
                seal::build_sealed_secret_response_with(
                    &luks_key(),
                    &xpub(&SEED_A),
                    n,
                    "unlock-key",
                    [9; 32],
                    [8; 12],
                )
            }),
        }
    });
    assert_eq!(
        r.unlock(
            Mode::Approve,
            RelayTiming {
                window_secs: 10_000,
                heartbeat_secs: 60,
                request_lifetime_secs: 21_600,
            }
        )
        .unwrap(),
        luks_key()
    );
    assert_eq!(
        *r.clock.waits.borrow(),
        vec![3, 6, 9, 12, 15, 15, 15, 15, 15, 15, 15, 15]
    );
    let w = r.worker.0.borrow();
    assert!(
        w.bodies.len() >= 3,
        "heartbeats re-announce: {}",
        w.bodies.len()
    );
    assert!(
        w.bodies.iter().all(|b| b == &w.bodies[0]),
        "every announce is the same signed request"
    );
    assert!(
        w.refusals.is_empty(),
        "the worker refused: {:?}",
        w.refusals
    );
    let polls = w
        .calls
        .iter()
        .filter(|(_, p)| p.starts_with("/api/boot/response/"))
        .count();
    assert_eq!(polls, 13);
}

fn bad_then_good(bad: Reply) -> impl FnOnce(&mut Worker) {
    move |w: &mut Worker| {
        w.reply = bad;
        w.next_reply = Some(reply_for(SEED_A, "unlock-key", None));
    }
}

/// The first reply does not open; the box signs a fresh request and opens the second.
fn assert_fresh_request_after(r: &mut Run, why: &str) {
    assert_eq!(r.unlock(Mode::Approve, QUICK).unwrap(), luks_key());
    let log = r.log();
    assert!(
        log.contains(&format!(
            "the reply did not open the disk: {why}; asking again"
        )),
        "{log}"
    );
    assert!(
        log.contains("asked the phone to approve (request 2)"),
        "{log}"
    );
    let w = r.worker.0.borrow();
    assert_eq!(w.nonces.len(), 2, "a fresh nonce for the second request");
    assert_ne!(w.bodies.first(), w.bodies.last());
}

#[test]
fn a_replayed_reply_is_refused_and_a_fresh_request_follows() {
    let mut r = Run::new(bad_then_good(reply_for(
        SEED_A,
        "unlock-key",
        Some("2323232323232323232323232323232323232323232323232323232323232323"),
    )));
    assert_fresh_request_after(&mut r, &seal::SealError::ContextMismatch.to_string());
}

#[test]
fn a_repurposed_reply_is_refused() {
    let mut r = Run::new(bad_then_good(reply_for(SEED_A, "entitlement", None)));
    assert_fresh_request_after(&mut r, &seal::SealError::ContextMismatch.to_string());
}

#[test]
fn a_reply_for_another_box_is_refused() {
    let mut r = Run::new(bad_then_good(reply_for(SEED_B, "unlock-key", None)));
    assert_fresh_request_after(&mut r, &seal::SealError::Authentication.to_string());
}

#[test]
fn a_reply_without_a_sealed_payload_asks_again() {
    let mut r = Run::new(|w| w.reply = Reply::Empty { after: 0 });
    assert_eq!(
        r.unlock(
            Mode::Approve,
            RelayTiming {
                window_secs: 60,
                ..QUICK
            }
        ),
        Err(UnlockError::WindowElapsed(60))
    );
    assert!(r.log().contains("no sealed payload; asking again"));
    assert!(r.worker.0.borrow().nonces.len() > 2);
}

#[test]
fn a_refused_announce_is_retried_after_30_seconds() {
    let mut r = Run::new(|w| {
        w.refuse_posts = 2;
        w.reply = reply_for(SEED_A, "unlock-key", None);
    });
    assert_eq!(r.unlock(Mode::Approve, QUICK).unwrap(), luks_key());
    assert_eq!(r.clock.waits.borrow()[..2], [30, 30]);
    assert!(r.log().contains("unlock request refused (HTTP 403"));
    assert!(r.log().contains("asked the phone to approve (request 3)"));
    assert_eq!(r.worker.0.borrow().nonces.len(), 3);
}

#[test]
fn a_request_is_signed_afresh_when_its_lifetime_ends() {
    let mut r = Run::new(|w| {
        w.reply = Reply::After {
            after: 8,
            build: Rc::new(|n: &str| {
                seal::build_sealed_secret_response_with(
                    &luks_key(),
                    &xpub(&SEED_A),
                    n,
                    "unlock-key",
                    [9; 32],
                    [8; 12],
                )
            }),
        };
    });
    let key = r
        .unlock(
            Mode::Approve,
            RelayTiming {
                window_secs: 600,
                heartbeat_secs: 600,
                request_lifetime_secs: 40,
            },
        )
        .unwrap();
    assert_eq!(key, luks_key());
    let w = r.worker.0.borrow();
    assert!(w.nonces.len() >= 2, "{:?}", w.nonces);
    let issued: Vec<u64> = w
        .bodies
        .iter()
        .map(|b| {
            serde_json::from_str::<serde_json::Value>(b).unwrap()["request"]["issuedAt"]
                .as_u64()
                .unwrap()
        })
        .collect();
    assert!(issued.windows(2).all(|p| p[0] < p[1]), "{issued:?}");
    assert!(w.refusals.is_empty(), "{:?}", w.refusals);
}

#[test]
fn timing_is_clamped_to_the_premount_bounds() {
    let t = RelayTiming {
        window_secs: 31_536_000,
        heartbeat_secs: 1,
        request_lifetime_secs: 100_000,
    }
    .clamped();
    assert_eq!(
        t,
        RelayTiming {
            window_secs: 604_800,
            heartbeat_secs: 10,
            request_lifetime_secs: 21_600,
        }
    );
    assert_eq!(
        RelayTiming {
            window_secs: 0,
            heartbeat_secs: 9_999,
            request_lifetime_secs: 0
        }
        .clamped(),
        RelayTiming {
            window_secs: 1,
            heartbeat_secs: 600,
            request_lifetime_secs: 2,
        }
    );
    assert_eq!(RelayTiming::default().window_secs, 604_800);
}

#[test]
fn transport_errors_while_polling_are_retried() {
    let mut r = Run::new(|w| {
        w.fail_transport_on_poll = vec![1, 2];
        w.reply = reply_for(SEED_A, "unlock-key", None);
    });
    assert_eq!(r.unlock(Mode::Approve, QUICK).unwrap(), luks_key());
    assert!(r.log().contains("HTTP 000"));
}

#[test]
fn the_window_bounds_the_wait() {
    let mut r = Run::new(|_| {});
    assert_eq!(
        r.unlock(
            Mode::Approve,
            RelayTiming {
                window_secs: 60,
                ..QUICK
            }
        ),
        Err(UnlockError::WindowElapsed(60))
    );
    assert_eq!(
        r.clock.waits.borrow().iter().sum::<u64>(),
        3 + 6 + 9 + 12 + 15 + 15
    );
}

#[test]
fn manual_on_the_console_stops_the_relay() {
    let mut r = Run::new(|_| {});
    r.clock.manual_on_wait = Some(2);
    assert_eq!(
        r.unlock(Mode::Approve, QUICK),
        Err(UnlockError::ManualSelected)
    );
}

#[test]
fn a_stale_clock_is_refused_by_the_worker() {
    let mut r = Run::new(own_lease);
    // Box clock 10 minutes behind the worker: the lease GET and every announce are stale.
    r.worker.0.borrow_mut().now = Rc::new(Cell::new(T0 + 10 * 60_000));
    assert_eq!(
        r.unlock(
            Mode::Auto,
            RelayTiming {
                window_secs: 60,
                ..QUICK
            }
        ),
        Err(UnlockError::WindowElapsed(60))
    );
    let w = r.worker.0.borrow();
    assert!(w.refusals.len() >= 3);
    assert!(w.refusals.iter().all(|x| x == "stale request"));
}
